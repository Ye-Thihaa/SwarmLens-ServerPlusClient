/**
 * Shared between routes/capture.tsx (live preview + shot-time bake-in) and
 * routes/album.tsx (a whole composited strip, layered over already-baked
 * photos the same way a real photo booth's single house filter sits over
 * everyone's prints). One formula, one place, rather than two copies
 * drifting apart the first time either gets tuned.
 */

/** Per-stock starting point -- picking a stock resets to its own preset
 * rather than keeping whatever the previous stock's sliders were left at,
 * matching a real film swap more than a shared global edit. Keyed by the
 * same filmStocks[].key contract ai_engine.py's FILM_STOCKS uses. */
export const STOCK_PRESETS: Record<string, { tone: number; color: number; palette: number }> = {
  portra_400: { tone: -10, color: 85, palette: 65 },
  cinestill_800t: { tone: -20, color: 100, palette: 80 },
  tri_x_400: { tone: 0, color: 0, palette: 100 },
  ektar_100: { tone: 10, color: 130, palette: 60 },
  gold_200: { tone: 5, color: 90, palette: 70 },
};
export const DEFAULT_PRESET = { tone: 0, color: 100, palette: 50 };

/** One look, expressed as ordered operations. Both the live CSS preview
 * and the pixel bake are derived from this list, so they cannot drift:
 * previously the preview was a CSS string and the bake was the same string
 * handed to ctx.filter, which looked like one source of truth right up
 * until a browser implemented one and not the other. */
// One literal per member, not a union of literals inside one member:
// TypeScript only narrows a discriminated union when each member's
// discriminant is a single literal type.
export type FilterOp =
  | { t: "brightness"; v: number }
  | { t: "contrast"; v: number }
  | { t: "saturate"; v: number }
  | { t: "grayscale"; v: number }
  | { t: "sepia"; v: number }
  | { t: "hue-rotate"; deg: number };

/** TONE/COLOR/PALETTE -> the ops that make up a stock's look.
 *
 * TONE drives brightness/contrast around neutral; COLOR is a direct
 * saturation percentage (0 = grayscale, 100 = unchanged); PALETTE (0..100)
 * scales each stock's own characteristic secondary treatment, so turning
 * it down fades toward "no particular stock" rather than toward black. */
export function filterOps(
  stockKey: string,
  tone: number,
  color: number,
  palette: number,
): FilterOp[] {
  const p = palette / 100;
  const ops: FilterOp[] = [
    { t: "brightness", v: 1 + tone / 250 },
    { t: "contrast", v: 1 + Math.abs(tone) / 400 },
    { t: "saturate", v: color / 100 },
  ];

  switch (stockKey) {
    case "tri_x_400":
      ops.push({ t: "grayscale", v: p }, { t: "contrast", v: 1 + 0.25 * p });
      break;
    case "cinestill_800t":
      ops.push({ t: "hue-rotate", deg: -6 * p }, { t: "saturate", v: 1 + 0.3 * p });
      break;
    case "ektar_100":
      ops.push({ t: "saturate", v: 1 + 0.4 * p });
      break;
    case "gold_200":
      ops.push({ t: "sepia", v: 0.25 * p });
      break;
    case "portra_400":
      ops.push({ t: "sepia", v: 0.12 * p }, { t: "saturate", v: 1 - 0.1 * p });
      break;
  }
  return ops;
}

/** The same look as a CSS `filter` string, for the live preview. */
export function buildFilterCss(
  stockKey: string,
  tone: number,
  color: number,
  palette: number,
): string {
  return filterOps(stockKey, tone, color, palette)
    .map((o) =>
      o.t === "hue-rotate" ? `hue-rotate(${o.deg.toFixed(1)}deg)` : `${o.t}(${o.v.toFixed(3)})`,
    )
    .join(" ");
}

/** Does this browser's canvas actually honour ctx.filter?
 *
 * Not a property sniff -- Safari shipped the property before it did the
 * behaviour, and assigning to an ignored `filter` throws nothing and
 * returns nothing, so a saved photo silently came out unfiltered while the
 * on-screen preview (a CSS filter on the element, which every browser
 * does) looked perfect. That gap is exactly the bug this guards: paint one
 * red pixel through grayscale(1) and check the pixel actually turned grey. */
let ctxFilterOk: boolean | null = null;
export function canvasFilterSupported(): boolean {
  if (ctxFilterOk !== null) return ctxFilterOk;
  if (typeof document === "undefined") return (ctxFilterOk = false);
  try {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const ctx = probe.getContext("2d");
    if (!ctx || !("filter" in ctx)) return (ctxFilterOk = false);
    ctx.filter = "grayscale(1)";
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    ctxFilterOk = r === g && g === b;
  } catch {
    ctxFilterOk = false;
  }
  return ctxFilterOk;
}

/** Applies `ops` to a region of a canvas in place, in sRGB, in order --
 * the same colour maths the CSS filter functions are defined as, done by
 * hand for browsers whose canvas ignores ctx.filter. */
export function applyFilterOps(
  ctx: CanvasRenderingContext2D,
  ops: FilterOp[],
  x: number,
  y: number,
  w: number,
  h: number,
) {
  if (w <= 0 || h <= 0 || ops.length === 0) return;
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i]! / 255,
      g = d[i + 1]! / 255,
      b = d[i + 2]! / 255;

    for (const op of ops) {
      if (op.t === "brightness") {
        r *= op.v;
        g *= op.v;
        b *= op.v;
      } else if (op.t === "contrast") {
        const o = -0.5 * op.v + 0.5;
        r = r * op.v + o;
        g = g * op.v + o;
        b = b * op.v + o;
      } else if (op.t === "saturate" || op.t === "grayscale") {
        // grayscale(a) is saturate(1-a): both interpolate toward luminance.
        const s = op.t === "grayscale" ? 1 - op.v : op.v;
        const nr = (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b;
        const ng = (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b;
        const nb = (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b;
        r = nr;
        g = ng;
        b = nb;
      } else if (op.t === "sepia") {
        const a = op.v;
        const nr = (0.393 + 0.607 * (1 - a)) * r + 0.769 * a * g + 0.189 * a * b;
        const ng = 0.349 * a * r + (0.686 + 0.314 * (1 - a)) * g + 0.168 * a * b;
        const nb = 0.272 * a * r + 0.534 * a * g + (0.131 + 0.869 * (1 - a)) * b;
        r = nr;
        g = ng;
        b = nb;
      } else {
        const rad = (op.deg * Math.PI) / 180;
        const c = Math.cos(rad),
          s2 = Math.sin(rad);
        const nr =
          (0.213 + c * 0.787 - s2 * 0.213) * r +
          (0.715 - c * 0.715 - s2 * 0.715) * g +
          (0.072 - c * 0.072 + s2 * 0.928) * b;
        const ng =
          (0.213 - c * 0.213 + s2 * 0.143) * r +
          (0.715 + c * 0.285 + s2 * 0.14) * g +
          (0.072 - c * 0.072 - s2 * 0.283) * b;
        const nb =
          (0.213 - c * 0.213 - s2 * 0.787) * r +
          (0.715 - c * 0.715 + s2 * 0.715) * g +
          (0.072 + c * 0.928 + s2 * 0.072) * b;
        r = nr;
        g = ng;
        b = nb;
      }
      // Clamp between stages, not just at the end: browsers hand each
      // filter primitive's output to the next through an 8-bit buffer, so
      // a stock whose saturate pushes past 1 (ektar, gold) diverges by a
      // few levels if the overflow is carried in floating point instead.
      r = r <= 0 ? 0 : r >= 1 ? 1 : r;
      g = g <= 0 ? 0 : g >= 1 ? 1 : g;
      b = b <= 0 ? 0 : b >= 1 ? 1 : b;
    }

    d[i] = r <= 0 ? 0 : r >= 1 ? 255 : r * 255;
    d[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : g * 255;
    d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255;
  }
  ctx.putImageData(img, x, y);
}

/** Draw `src` into `ctx` with a stock's look baked into real pixels,
 * whichever way this browser can actually do it. Every save path goes
 * through here so none of them can regress to preview-only again. */
export function drawFiltered(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
  ops: FilterOp[],
) {
  withFilter(ctx, ops, { x, y, w, h }, () => ctx.drawImage(src, x, y, w, h));
}

/** Same guarantee as drawFiltered for callers that need drawImage's
 * source-rect form (album.tsx crops each cell): run `draw`, and make sure
 * the look ends up in the pixels it painted either way. `rect` is the
 * destination region to re-process when ctx.filter is unavailable. */
export function withFilter(
  ctx: CanvasRenderingContext2D,
  ops: FilterOp[],
  rect: { x: number; y: number; w: number; h: number },
  draw: () => void,
) {
  if (ops.length === 0) {
    draw();
    return;
  }
  if (canvasFilterSupported()) {
    const previous = ctx.filter;
    ctx.filter = filterOpsToCss(ops);
    draw();
    ctx.filter = previous || "none";
    return;
  }
  draw();
  applyFilterOps(ctx, ops, Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h));
}

function filterOpsToCss(ops: FilterOp[]): string {
  return ops
    .map((o) =>
      o.t === "hue-rotate" ? `hue-rotate(${o.deg.toFixed(1)}deg)` : `${o.t}(${o.v.toFixed(3)})`,
    )
    .join(" ");
}
