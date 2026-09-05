import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { filmStocks } from "@/guest/data";
import { BOOTH_ZONE, getPhotos, photoImageUrl, pickNode, type RemotePhoto } from "@/lib/api";
import { useCurrentEvent } from "@/lib/event";
import { DEFAULT_PRESET, filterOps, STOCK_PRESETS, withFilter } from "@/lib/filmStock";
import { currentGuestId, tick } from "@/lib/guest";
import { addPhoto, photosForEvent, syncOutbox, useOutbox, type OutboxPhoto } from "@/lib/outbox";

export const Route = createFileRoute("/album")({
  head: () => ({
    meta: [
      { title: "Make a strip — SwarmLens" },
      {
        name: "description",
        content:
          "Pick a layout, pick your photos, pick a frame — turn tonight's roll into a printable photo strip.",
      },
      { property: "og:title", content: "Make a strip — SwarmLens" },
      {
        property: "og:description",
        content: "A keepsake from tonight, built from your own frames.",
      },
    ],
  }),
  component: Album,
});

/** A cell is a fraction of the photo area (0..1), not a grid coordinate --
 * this is what lets a layout be an asymmetric collage (one big photo plus
 * three small ones) and a plain uniform grid through the exact same
 * renderer, instead of needing two different code paths. */
type Cell = { x: number; y: number; w: number; h: number };
type Layout = {
  id: string;
  label: string;
  count: number;
  cells: Cell[];
  /** width/height of just the photo area, before the frame padding and
   * footer -- a 4-photo strip and a 2x2 grid both hold 4 photos but want
   * very different canvas proportions. */
  photoAreaAspect: number;
};

function gridCells(cols: number, rows: number): Cell[] {
  const cells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
    }
  }
  return cells;
}

// Spans every count from 1 to 10 across a mix of classic photo-booth strips,
// plain grids, and a few asymmetric collages -- real variety without
// hand-building ten near-duplicate uniform grids.
const LAYOUTS: Layout[] = [
  { id: "solo", label: "Solo", count: 1, cells: gridCells(1, 1), photoAreaAspect: 3 / 4 },
  {
    id: "duo-stack",
    label: "2-up strip",
    count: 2,
    cells: gridCells(1, 2),
    photoAreaAspect: 3 / 5.6,
  },
  {
    id: "duo-side",
    label: "Side by side",
    count: 2,
    cells: gridCells(2, 1),
    photoAreaAspect: 4 / 2.3,
  },
  {
    id: "trio-stack",
    label: "3-up strip",
    count: 3,
    cells: gridCells(1, 3),
    photoAreaAspect: 3 / 7.6,
  },
  {
    id: "tall-duo",
    label: "Tall + duo",
    count: 3,
    cells: [
      { x: 0, y: 0, w: 0.56, h: 1 },
      { x: 0.56, y: 0, w: 0.44, h: 0.5 },
      { x: 0.56, y: 0.5, w: 0.44, h: 0.5 },
    ],
    photoAreaAspect: 4 / 3,
  },
  {
    id: "classic-strip",
    label: "Classic strip",
    count: 4,
    cells: gridCells(1, 4),
    photoAreaAspect: 3 / 9.6,
  },
  { id: "grid-4", label: "2×2 grid", count: 4, cells: gridCells(2, 2), photoAreaAspect: 4 / 4.2 },
  {
    id: "hero-trio",
    label: "Hero + trio",
    count: 4,
    cells: [
      { x: 0, y: 0, w: 1, h: 0.6 },
      { x: 0, y: 0.6, w: 1 / 3, h: 0.4 },
      { x: 1 / 3, y: 0.6, w: 1 / 3, h: 0.4 },
      { x: 2 / 3, y: 0.6, w: 1 / 3, h: 0.4 },
    ],
    photoAreaAspect: 4 / 5,
  },
  { id: "grid-6", label: "2×3 grid", count: 6, cells: gridCells(2, 3), photoAreaAspect: 4 / 6 },
  { id: "grid-8", label: "2×4 grid", count: 8, cells: gridCells(2, 4), photoAreaAspect: 4 / 8 },
  { id: "grid-9", label: "3×3 grid", count: 9, cells: gridCells(3, 3), photoAreaAspect: 4 / 4.2 },
  { id: "grid-10", label: "2×5 grid", count: 10, cells: gridCells(2, 5), photoAreaAspect: 4 / 10 },
];

// Curated frame colors pulled straight from the app's own design system
// (hex values from styles.css's header comment), sitting alongside a real
// color wheel rather than replacing it -- a small set of colors that
// already belong to this app, plus the option to pick literally anything.
const FRAME_PRESETS = [
  { key: "cream", label: "Cream", hex: "#EDE6D6" },
  { key: "black", label: "Black", hex: "#1C1A17" },
  { key: "white", label: "White", hex: "#FFFFFF" },
  { key: "safelight", label: "Safelight", hex: "#C4392B" },
  { key: "converged", label: "Converged", hex: "#3F7D5A" },
  { key: "drifting", label: "Drifting", hex: "#D9A02B" },
] as const;

// Additive to the app's own three UI fonts (Bricolage Grotesque, Work Sans,
// JetBrains Mono, all already loaded in __root.tsx) -- Playfair Display and
// Great Vibes are loaded there specifically for this footer, because a
// printed keepsake earns a more ornamental hand than an in-app label does.
// Default is Elegant: a serif reads as "made for this" for most events a
// guest would print a strip from, without committing to the script font's
// stronger personality.
const FONT_STYLES = [
  {
    key: "elegant",
    label: "Elegant",
    family: "'Playfair Display', serif",
    weight: "700",
    cursive: false,
  },
  {
    key: "modern",
    label: "Modern",
    family: "'Bricolage Grotesque', sans-serif",
    weight: "800",
    cursive: false,
  },
  {
    key: "romantic",
    label: "Romantic",
    family: "'Great Vibes', cursive",
    weight: "400",
    cursive: true,
  },
  {
    key: "typewriter",
    label: "Typewriter",
    family: "'JetBrains Mono', monospace",
    weight: "700",
    cursive: false,
  },
] as const;
type FontStyleKey = (typeof FONT_STYLES)[number]["key"];

/** Any already-resolved image source -- a local outbox data: URI (this
 * guest's own shots) or a node's /photos/{id}/image URL (anyone's, when
 * browsing THE ROOM) -- normalized to one shape so the layout picker,
 * selection, and renderer never need to know which source a photo came
 * from. */
type PickablePhoto = { id: string; src: string; by?: string };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // No-op on a data: URI; required for a cross-node URL so the canvas
    // isn't tainted once toBlob/toDataURL runs on it -- main.py's CORS is
    // wide open (allow_origins=["*"]), so this succeeds rather than hanging.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to decode"));
    img.src = src;
  });
}

/** Relative-luminance contrast pick, not a fixed light/dark pair -- the
 * frame color comes from an open color wheel now, so footer text has to
 * stay readable against whatever the guest actually picks, not just the
 * six curated presets. */
function contrastTextColor(hex: string): string {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#1C1A17" : "#EDE6D6";
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Draws the chosen layout onto a fresh canvas: frame color fill, each
 * photo cover-cropped into its cell -- through the chosen film stock's
 * filter if one is set, the same way a real photo booth's single house
 * filter sits over every print it makes, not something reapplied per shot
 * -- then the event name / date / message baked into the footer with a
 * real typographic hierarchy. A composited image, not a CSS mockup that
 * only exists on screen.
 *
 * Takes already-decoded images, not photo sources -- this is what makes a
 * live preview affordable. Switching frame color or filter re-runs this on
 * every change (debounced, see the component's effect), and re-fetching
 * and re-decoding N JPEGs on every color-wheel drag would make "live" a
 * lie; the caller loads each image once via resolveImages' cache and hands
 * back the same HTMLImageElement for every redraw after that. */
async function renderStrip(
  images: (HTMLImageElement | null)[],
  layout: Layout,
  frameHex: string,
  stockKey: string | null,
  eventName: string,
  eventDate: string,
  message: string,
  fontStyleKey: FontStyleKey,
): Promise<HTMLCanvasElement> {
  // Canvas text uses whatever's currently loaded for this page; without
  // this the very first strip a guest develops can silently fall back to
  // a generic serif for a frame or two before the chosen webfont finishes
  // loading, and there's no visual sign anything went wrong.
  await document.fonts.ready;

  const frameText = contrastTextColor(frameHex);
  const fontStyle = FONT_STYLES.find((f) => f.key === fontStyleKey) ?? FONT_STYLES[0];
  const photoAreaW = 900;
  const photoAreaH = Math.round(photoAreaW / layout.photoAreaAspect);
  const pad = 28;
  const gap = 12;
  const hasFooterText = Boolean(eventName || message);
  const footerH = hasFooterText ? 224 : 100;
  const canvasW = photoAreaW + pad * 2;
  const canvasH = photoAreaH + pad * 2 + footerH;

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = frameHex;
  ctx.fillRect(0, 0, canvasW, canvasH);

  const stockPreset = stockKey ? (STOCK_PRESETS[stockKey] ?? DEFAULT_PRESET) : null;
  const stockOps =
    stockKey && stockPreset
      ? filterOps(stockKey, stockPreset.tone, stockPreset.color, stockPreset.palette)
      : [];

  layout.cells.forEach((cell, i) => {
    const x = pad + cell.x * photoAreaW + gap / 2;
    const y = pad + cell.y * photoAreaH + gap / 2;
    const w = cell.w * photoAreaW - gap;
    const h = cell.h * photoAreaH - gap;

    const img = images[i];
    if (!img) {
      // Not enough photos chosen yet for this cell -- a dim placeholder so
      // it reads as "not shot yet", not a rendering glitch.
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.fillRect(x, y, w, h);
      return;
    }
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;
    withFilter(ctx, stockOps, { x, y, w, h }, () =>
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h),
    );
  });

  ctx.fillStyle = frameText;
  ctx.textAlign = "center";
  let ty = pad + photoAreaH + 50;

  if (eventName) {
    const nameSize = fontStyle.cursive ? 58 : 42;
    ctx.font = `${fontStyle.weight} ${nameSize}px ${fontStyle.family}`;
    ctx.fillText(fontStyle.cursive ? eventName : eventName.toUpperCase(), canvasW / 2, ty);
    ty += fontStyle.cursive ? 42 : 36;
  }
  if (eventDate) {
    ctx.font = "600 19px 'JetBrains Mono', monospace";
    ctx.fillText(eventDate, canvasW / 2, ty);
    ty += 30;
  }
  if (message) {
    ctx.font = "italic 400 18px 'Work Sans', sans-serif";
    for (const line of wrapText(ctx, message, photoAreaW - 60)) {
      ty += 25;
      ctx.fillText(line, canvasW / 2, ty);
    }
  }
  if (!hasFooterText) {
    ctx.font = "700 20px 'JetBrains Mono', monospace";
    ctx.fillText("S W A R M L E N S", canvasW / 2, pad + photoAreaH + footerH / 2 + 8);
  }

  return canvas;
}

function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}

/** Opens the composited strip in its own tab and triggers the OS print
 * dialog -- this is a web app, so "print it out" honestly means "hand the
 * image to whatever printer the guest already has access to", not a real
 * print-service integration. Must run synchronously inside the click
 * handler that calls it, or popup blockers eat the new tab. */
function printCanvas(canvas: HTMLCanvasElement) {
  const dataUrl = canvas.toDataURL("image/png");
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(
    `<!doctype html><html><head><title>Print your strip</title><style>
      @page { margin: 0; }
      body { margin: 0; display: flex; align-items: center; justify-content: center; background: #fff; min-height: 100vh; }
      img { max-width: 100%; height: auto; }
    </style></head><body><img src="${dataUrl}" alt="Photo strip" /></body></html>`,
  );
  win.document.close();
  win.onload = () => win.print();
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function Album() {
  const event = useCurrentEvent();
  const outbox = useOutbox();
  const myRoll = useMemo(
    () => photosForEvent(outbox, event.event_id).sort((a, b) => b.created_at - a.created_at),
    [outbox, event.event_id],
  );

  // THE ROOM: everyone's photos, not just this phone's. GET /photos + a
  // node URL is all main.py already exposes -- no backend change needed to
  // let a strip pull from photos this device never shot itself.
  const [source, setSource] = useState<"mine" | "room">("mine");
  const [node, setNode] = useState<string | null>(null);
  const [roomPhotos, setRoomPhotos] = useState<RemotePhoto[]>([]);
  useEffect(() => {
    if (source !== "room") return;
    let cancelled = false;
    async function poll() {
      const n = await pickNode();
      if (cancelled) return;
      setNode(n);
      if (!n) return;
      try {
        const ps = await getPhotos(n, event.event_id);
        if (!cancelled) setRoomPhotos(ps);
      } catch {
        // stay on the last known-good read
      }
    }
    void poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [source, event.event_id]);

  const pickable: PickablePhoto[] = useMemo(() => {
    if (source === "mine") {
      // Once a frame syncs its bytes are released to the cluster (see
      // outbox.ts's syncOne), so fall back to the node-served copy. An
      // empty base64 payload is a truthy string and renders as a broken
      // tile, so it must never be handed on as a src.
      return myRoll
        .map((p) => ({
          id: p.local_id,
          src: p.image_base64
            ? `data:image/jpeg;base64,${p.image_base64}`
            : p.photo_id && node
              ? photoImageUrl(node, p.photo_id)
              : null,
        }))
        .filter((p): p is PickablePhoto => p.src !== null);
    }
    if (!node) return [];
    return roomPhotos.map((p) => ({
      id: p.photo_id,
      src: photoImageUrl(node, p.photo_id),
      by: p.guest_id,
    }));
  }, [source, myRoll, roomPhotos, node]);

  const [layoutId, setLayoutId] = useState(LAYOUTS[5]!.id); // classic strip -- the archetype
  const layout = LAYOUTS.find((l) => l.id === layoutId)!;

  // Selection order IS strip order: the first photo tapped fills cell 0, and
  // so on. Re-tapping a selected photo removes it and every later photo
  // shifts up a slot, same as it would sliding a print out of a stack.
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    setSelected((s) => s.slice(0, layout.count));
  }, [layout.count]);
  useEffect(() => {
    setSelected([]);
    setPreviewUrl(null);
  }, [source]);

  const [frameKey, setFrameKey] = useState<(typeof FRAME_PRESETS)[number]["key"]>(
    FRAME_PRESETS[0].key,
  );
  const [customColor, setCustomColor] = useState("#EDE6D6");
  const [useCustomColor, setUseCustomColor] = useState(false);
  const frameHex = useCustomColor
    ? customColor
    : FRAME_PRESETS.find((f) => f.key === frameKey)!.hex;

  // No stock selected = the photos keep whatever look they already have
  // (most were shot through capture.tsx's own AI-recommended stock already).
  // Picking one here re-applies it over the WHOLE strip uniformly, the way a
  // real booth's single house filter treats every print the same, rather
  // than mixing five guests' five different individual choices.
  const [stockKey, setStockKey] = useState<string | null>(null);

  const [fontStyleKey, setFontStyleKey] = useState<FontStyleKey>("elegant");
  const eventName = event.name;
  const [eventDate, setEventDate] = useState(todayLabel);
  const [message, setMessage] = useState("");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Decoded-image cache, keyed by src -- a color, filter, font, or words
  // change redraws the whole canvas, but never re-fetches or re-decodes a
  // photo it's already loaded once. Without this, "live" would mean
  // re-downloading N JPEGs on every drag of the color wheel.
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>());

  function pickLayout(id: string) {
    setLayoutId(id);
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      if (s.includes(id)) return s.filter((x) => x !== id);
      if (s.length >= layout.count) return s;
      return [...s, id];
    });
  }

  const ready = selected.length === layout.count;

  async function resolveImages(chosen: PickablePhoto[]): Promise<(HTMLImageElement | null)[]> {
    return Promise.all(
      chosen.map(async (p) => {
        const cached = imageCacheRef.current.get(p.src);
        if (cached) return cached;
        try {
          const img = await loadImage(p.src);
          imageCacheRef.current.set(p.src, img);
          return img;
        } catch {
          return null;
        }
      }),
    );
  }

  // Live preview: re-renders automatically on any change to layout, photo
  // selection, frame color, filter, font, or words -- this IS the "show me
  // what I'd get" demo while choosing, not a separate step after. Debounced
  // 250ms so dragging the color wheel or typing a message doesn't fire a
  // render per event. The previous preview stays on screen while a new one
  // is pending -- nothing here ever resets to blank, only ever gets
  // replaced by something newer.
  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    const t = setTimeout(async () => {
      const chosen = selected
        .map((id) => pickable.find((p) => p.id === id))
        .filter((p): p is PickablePhoto => Boolean(p));
      const images = await resolveImages(chosen);
      if (cancelled) return;
      const canvas = await renderStrip(
        images,
        layout,
        frameHex,
        stockKey,
        eventName,
        eventDate.trim(),
        message.trim(),
        fontStyleKey,
      );
      if (cancelled) return;
      canvasRef.current = canvas;
      setPreviewUrl(canvas.toDataURL("image/jpeg", 0.85));
      setPosted(false);
      setRendering(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, layout, frameHex, stockKey, eventDate, message, fontStyleKey, pickable]);

  /** Posts the composited strip to THE ROOM's public album -- reuses
   * POST /photos (the same endpoint every ordinary capture goes through)
   * tagged with zone "photo_booth", one of the five zones this backend
   * already knows about. No new event kind, no new endpoint: a posted
   * strip gossips, replicates and shows up everywhere a photo already
   * does, and event.$slug.tsx's PHOTO BOOTH tab is just that zone filtered
   * out from the rest. */
  async function postToPublicAlbum() {
    if (!canvasRef.current) return;
    setPosting(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvasRef.current!.toBlob(resolve, "image/jpeg", 0.92),
      );
      if (!blob) return;
      const image_base64 = await blobToBase64(blob);
      addPhoto({
        local_id: crypto.randomUUID(),
        guest_id: currentGuestId(event.event_id),
        zone: BOOTH_ZONE,
        composition_score: 0,
        vclock: tick(),
        image_base64,
        event_id: event.event_id,
      });
      void syncOutbox();
      setPosted(true);
    } finally {
      setPosting(false);
    }
  }

  return (
    <main className="grain min-h-screen pb-16">
      <header className="border-b border-border px-5 pt-8 pb-5">
        <Link to="/mine" className="font-mono text-[0.6rem] tracking-widest text-fixer-dim">
          ← MY ROLL
        </Link>
        <h1 className="mt-2 text-3xl font-extrabold">Make a strip</h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          A layout, your own photos (or anyone's in the room) in the order you pick them, a frame, a
          filter, and a few words — then save it, print it, or post it for everyone to see.
        </p>
      </header>

      {/* Live demo -- the whole point of this bar. Sticky so it stays in
          view while scrolling through layout/photos/frame/filter/words
          below: the "what would I get" question should be answerable
          without scrolling back up after every tap. */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-emulsion/95 px-5 py-3 backdrop-blur">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-sm border border-border bg-card">
          {previewUrl ? (
            <img src={previewUrl} alt="Live preview" className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="font-mono text-[0.38rem] tracking-widest text-stale">LOADING</span>
            </div>
          )}
          {rendering && <div className="settling absolute inset-0 bg-emulsion/35" />}
        </div>
        <p className="text-[0.72rem] leading-snug text-muted-foreground">
          This updates live as you pick a layout, photos, frame color, filter, or font.
        </p>
      </div>

      <section className="px-5 py-5">
        <p className="label-mono mb-2">1. LAYOUT</p>
        <div className="flex gap-2.5 overflow-x-auto pb-2 [scrollbar-width:none]">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              onClick={() => pickLayout(l.id)}
              className={`shrink-0 rounded-sm border p-2 text-center ${
                l.id === layoutId ? "border-drifting bg-drifting/15" : "border-border bg-card"
              }`}
            >
              <div
                className="relative overflow-hidden rounded-[3px] bg-fixer-dim/25"
                style={{ width: "3.6rem", aspectRatio: l.photoAreaAspect }}
              >
                {l.cells.map((c, i) => (
                  <div
                    key={i}
                    className="absolute rounded-[1px] bg-fixer-dim"
                    style={{
                      left: `${c.x * 100 + 3}%`,
                      top: `${c.y * 100 + 3}%`,
                      width: `${c.w * 100 - 6}%`,
                      height: `${c.h * 100 - 6}%`,
                    }}
                  />
                ))}
              </div>
              <p className="mt-1.5 w-16 font-mono text-[0.48rem] tracking-widest text-fixer-dim">
                {l.label}
              </p>
            </button>
          ))}
        </div>
      </section>

      <section className="px-5 pb-5">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="label-mono">2. PHOTOS</p>
          <p className="font-mono text-[0.6rem] tracking-widest text-fixer-dim">
            {selected.length} / {layout.count}
            {selected.length > 0 && (
              <button onClick={() => setSelected([])} className="ml-2 text-safelight underline">
                clear
              </button>
            )}
          </p>
        </div>

        <div className="mb-3 flex gap-1.5">
          <button
            onClick={() => setSource("mine")}
            className={`flex-1 rounded-sm border py-2 font-mono text-[0.6rem] tracking-widest ${
              source === "mine"
                ? "border-drifting bg-drifting/15 text-drifting"
                : "border-border text-fixer-dim"
            }`}
          >
            MY ROLL
          </button>
          <button
            onClick={() => setSource("room")}
            className={`flex-1 rounded-sm border py-2 font-mono text-[0.6rem] tracking-widest ${
              source === "room"
                ? "border-drifting bg-drifting/15 text-drifting"
                : "border-border text-fixer-dim"
            }`}
          >
            THE ROOM
          </button>
        </div>

        {pickable.length === 0 ? (
          <p className="rounded-sm border border-drifting/40 bg-drifting/10 px-3 py-2 text-sm text-drifting">
            {source === "mine"
              ? "Nothing on your roll yet — shoot a few frames first."
              : node
                ? "Nobody's shot a frame yet."
                : "Waiting for a node to answer…"}
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {pickable.map((p) => {
              const idx = selected.indexOf(p.id);
              const isSelected = idx >= 0;
              const full = !isSelected && selected.length >= layout.count;
              return (
                <button
                  key={p.id}
                  onClick={() => toggleSelect(p.id)}
                  disabled={full}
                  aria-pressed={isSelected}
                  className={`relative aspect-square overflow-hidden rounded-sm border-2 transition ${
                    isSelected ? "border-drifting" : "border-transparent"
                  } ${full ? "opacity-30" : "active:scale-95"}`}
                >
                  <img src={p.src} alt="" className="h-full w-full object-cover" />
                  {isSelected && (
                    <span className="absolute top-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-drifting font-mono text-[0.55rem] font-bold text-emulsion">
                      {idx + 1}
                    </span>
                  )}
                  {p.by && (
                    <span className="absolute right-0.5 bottom-0.5 rounded-sm bg-emulsion/80 px-1 font-mono text-[0.42rem] tracking-widest text-fixer-dim">
                      {p.by}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="px-5 pb-5">
        <p className="label-mono mb-2">3. FRAME COLOR</p>
        <div className="flex flex-wrap items-center gap-2.5">
          {FRAME_PRESETS.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setUseCustomColor(false);
                setFrameKey(f.key);
              }}
              aria-label={f.label}
              aria-pressed={!useCustomColor && f.key === frameKey}
              className={`h-9 w-9 rounded-full border-2 transition ${
                !useCustomColor && f.key === frameKey ? "border-drifting" : "border-transparent"
              }`}
              style={{ backgroundColor: f.hex, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.15)" }}
            />
          ))}
          {/* The wheel itself: a real native color picker (an actual HSV
              wheel/spectrum on most phones), not a hand-rolled approximation
              -- the conic-gradient ring is just the affordance that says
              "tap for any color", layered under the real <input>. */}
          <label
            className={`relative h-9 w-9 cursor-pointer rounded-full border-2 transition ${
              useCustomColor ? "border-drifting" : "border-transparent"
            }`}
            style={{
              background:
                "conic-gradient(from 0deg, #f43f3f, #f4cf3f, #6ee06e, #3fd0f4, #6a5cf4, #f43fbd, #f43f3f)",
              boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.15)",
            }}
            aria-label="Custom color"
          >
            <input
              type="color"
              value={customColor}
              onChange={(e) => {
                setCustomColor(e.target.value);
                setUseCustomColor(true);
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </div>
      </section>

      <section className="px-5 pb-5">
        <p className="label-mono mb-2">4. FILTER (OPTIONAL)</p>
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          <button
            onClick={() => setStockKey(null)}
            className={`shrink-0 rounded-sm border px-3 py-2 font-mono text-[0.55rem] tracking-widest ${
              stockKey === null
                ? "border-drifting bg-drifting/15 text-drifting"
                : "border-border text-fixer-dim"
            }`}
          >
            AS SHOT
          </button>
          {filmStocks.map((f) => (
            <button
              key={f.key}
              onClick={() => setStockKey(f.key)}
              className={`shrink-0 rounded-sm border px-3 py-2 text-left font-mono text-[0.55rem] tracking-widest ${
                stockKey === f.key
                  ? "border-drifting bg-drifting/15 text-drifting"
                  : "border-border text-fixer-dim"
              }`}
            >
              {f.name}
            </button>
          ))}
        </div>
        <p className="mt-1.5 font-mono text-[0.5rem] tracking-widest text-stale">
          LAYS OVER EVERY PHOTO IN THE STRIP THE SAME WAY — ONE HOUSE FILTER, LIKE A REAL BOOTH.
        </p>
      </section>

      <section className="px-5 pb-5">
        <p className="label-mono mb-2">5. WORDS</p>
        <div className="space-y-2.5">
          <div className="rounded-sm border border-border bg-card px-3 py-2.5">
            <p className="font-mono text-[0.5rem] tracking-widest text-fixer-dim">EVENT</p>
            <p className="text-sm font-semibold">{eventName || "—"}</p>
          </div>
          <input
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            placeholder="Date"
            maxLength={24}
            className="w-full rounded-sm border border-border bg-card px-3 py-2.5 font-mono text-xs tracking-widest placeholder:text-muted-foreground focus:border-drifting focus:outline-none"
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="A line to go under the frame — a wish, a toast, whatever's true"
            maxLength={120}
            rows={2}
            className="w-full resize-none rounded-sm border border-border bg-card px-3 py-2.5 text-sm italic placeholder:text-muted-foreground focus:border-drifting focus:outline-none"
          />
          <div>
            <p className="mb-1.5 font-mono text-[0.5rem] tracking-widest text-fixer-dim">FONT</p>
            <div className="flex gap-1.5">
              {FONT_STYLES.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFontStyleKey(f.key)}
                  style={{ fontFamily: f.family }}
                  className={`flex-1 rounded-sm border py-2 text-[0.85rem] ${
                    fontStyleKey === f.key
                      ? "border-drifting bg-drifting/15 text-drifting"
                      : "border-border text-fixer-dim"
                  }`}
                >
                  Ag
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 pb-8">
        <p className="label-mono mb-2">PREVIEW</p>
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="Your photo strip"
            className="mx-auto w-full max-w-sm rounded-sm border border-border"
          />
        ) : (
          <div className="flex aspect-[3/4] w-full max-w-sm items-center justify-center rounded-sm border border-dashed border-border">
            <span className="font-mono text-[0.6rem] tracking-widest text-stale">LOADING…</span>
          </div>
        )}

        {!ready ? (
          <p className="mt-4 rounded-sm border border-drifting/40 bg-drifting/10 px-3 py-2 text-center text-sm text-drifting">
            Pick {layout.count - selected.length} more photo
            {layout.count - selected.length === 1 ? "" : "s"} to finish this layout — the preview
            above already shows how it's shaping up.
          </p>
        ) : (
          <>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() =>
                  canvasRef.current &&
                  downloadCanvas(canvasRef.current, `swarmlens-strip-${Date.now()}.png`)
                }
                className="flex-1 rounded-sm border border-fixer/30 py-2.5 font-mono text-[0.65rem] tracking-widest text-fixer-dim active:scale-95"
              >
                SAVE TO DEVICE
              </button>
              <button
                onClick={() => canvasRef.current && printCanvas(canvasRef.current)}
                className="flex-1 rounded-sm border border-drifting bg-drifting/20 py-2.5 font-mono text-[0.65rem] font-bold tracking-widest text-drifting active:scale-95"
              >
                PRINT
              </button>
            </div>
            <button
              onClick={postToPublicAlbum}
              disabled={posting || posted}
              className="mt-3 w-full rounded-sm border border-converged bg-converged/15 py-2.5 font-mono text-[0.65rem] font-bold tracking-widest text-converged disabled:opacity-60"
            >
              {posted ? "✓ POSTED TO THE ROOM" : posting ? "POSTING…" : "POST TO PUBLIC ALBUM"}
            </button>
            {posted && (
              <p className="mt-2 text-center font-mono text-[0.55rem] tracking-widest text-fixer-dim">
                Find it under THE ROOM → PHOTO BOOTH once it's gossiped through.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
