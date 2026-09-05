import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import fs from "node:fs";
import path from "node:path";

// This module is the Nitro server entry (see vite.config.ts) -- it never
// ships to the browser, unlike src/start.ts which is isomorphic. Safe
// place for Node-only bootstrap. Loaded once at server boot, before any
// request is handled; handlers still read process.env fresh on every
// call (see lib/consoleAuth.ts), this just makes sure it's populated. No
// dependency on the `dotenv` package -- .env here is a flat KEY=VALUE
// file, nothing fancier is needed.
//
// Deliberately unconditional (overwrites, doesn't check "already set"):
// Vite's own internal env loading (dotenv-expand) reads this same .env
// earlier in the pipeline and treats `$` as variable-interpolation
// syntax -- a CONSOLE_PASSWORD=s3cret$val became just "s3cret" ($val
// resolved as a reference to an undefined var and expanded to empty
// string), and a guarded "only set if missing" write would have kept
// that mangled value instead of this file's literal one. This loader
// reads the raw file with no interpolation of any kind, so it must win.
function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv();

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// A client that hangs up mid-request is not a server error, and this app
// hangs up constantly and on purpose: pickNode() races /health against all
// three nodes with Promise.any, so two of every three are abandoned by
// design, and the capture route's AI preview loop aborts its in-flight
// request on every cleanup (~1.5s). With VITE_NODE_URLS=/n1,/n2,/n3 all of
// that runs through this dev server's proxy, so each abort closes an HTTP/2
// stream underneath us and srvx surfaces it here as an AbortError. Logging
// those as 500s buries real errors under noise nobody can act on -- the
// client is already gone and will never read the response we render. 499 is
// nginx's non-standard "Client Closed Request": nothing consumes it, it just
// keeps the status honest anywhere requests are tallied.
function isClientDisconnect(error: unknown, request: Request): boolean {
  if (request.signal.aborted) return true;
  // Walk the cause chain -- the abort arrives wrapped (the observed log read
  // "AbortError: ... caused by: AbortError"). Depth-capped: a cause chain is
  // attacker-adjacent input in the sense that nothing guarantees it's acyclic.
  let cursor: unknown = error;
  for (let depth = 0; cursor != null && depth < 10; depth += 1) {
    if (typeof cursor === "object" && (cursor as { name?: unknown }).name === "AbortError") {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(
  response: Response,
  request: Request,
): Promise<Response> {
  if (response.status < 500) return response;
  if (request.signal.aborted) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response, request);
    } catch (error) {
      if (isClientDisconnect(error, request)) return new Response(null, { status: 499 });
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
