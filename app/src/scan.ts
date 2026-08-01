// Document capture: live edge detection, perspective correction, and multi-page PDF.
//
// Two decisions worth stating, because both were arrived at the expensive way.
//
// 1. This runs in SAFARI, not an installed PWA. getUserMedia is unreliable in iOS
//    standalone-PWA mode — the camera permission is not persisted, Safari re-prompts, and
//    standalone can behave as though no camera exists. iOS 26 made home-screen sites default
//    INTO that mode. So the app is meant to be opened as a normal Safari tab, and index.html
//    deliberately omits apple-mobile-web-app-capable.
//
// 2. Detection runs on a DOWNSCALED frame. Edge detection does not get better above ~400px
//    for this purpose, and running it on a full 4K camera frame at 10fps would melt the
//    phone. Full resolution is used only for the final warp, where it actually matters.
//
// OpenCV.js + jscanify load lazily from a CDN the first time the scanner opens, so the
// ~9MB WASM is not on the critical path for someone who only wants to read a chat.

const OPENCV_URL = "https://docs.opencv.org/4.10.0/opencv.js";
const JSCANIFY_URL = "https://cdn.jsdelivr.net/npm/jscanify@1.4.0/src/jscanify.min.js";

/** Detection resolution. Small on purpose — see note 2 above. */
const DETECT_WIDTH = 384;
/** Detection cadence. The overlay reads as "live" well below 60fps, and every frame we skip
 * is battery we don't burn. */
const DETECT_INTERVAL_MS = 100;

declare global {
  interface Window {
    cv?: unknown;
    jscanify?: new () => JScanify;
  }
}

interface Corner {
  x: number;
  y: number;
}
export interface Quad {
  topLeftCorner: Corner;
  topRightCorner: Corner;
  bottomLeftCorner: Corner;
  bottomRightCorner: Corner;
}

interface JScanify {
  getCornerPoints(contour: unknown, img?: unknown): Quad;
  findPaperContour(img: unknown): unknown;
  extractPaper(canvas: HTMLCanvasElement, width: number, height: number, corners?: Quad): HTMLCanvasElement;
}

let loading: Promise<JScanify> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Loads OpenCV.js then jscanify, once. OpenCV signals readiness asynchronously AFTER the
 * script tag fires onload — using it before then throws deep inside the WASM glue. */
export function loadScanner(): Promise<JScanify> {
  if (loading) return loading;
  loading = (async () => {
    await loadScript(OPENCV_URL);
    await new Promise<void>((resolve, reject) => {
      const cv = window.cv as { onRuntimeInitialized?: () => void; Mat?: unknown } | undefined;
      if (cv?.Mat) return resolve(); // already warm
      const timer = setTimeout(() => reject(new Error("OpenCV did not initialize")), 60_000);
      (window.cv as { onRuntimeInitialized: () => void }).onRuntimeInitialized = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    await loadScript(JSCANIFY_URL);
    if (!window.jscanify) throw new Error("jscanify did not load");
    return new window.jscanify();
  })();
  return loading;
}

/** Finds the page in a frame, or null when nothing convincing is there. Coordinates come
 * back in the SOURCE canvas's pixel space. */
export function detectQuad(scanner: JScanify, canvas: HTMLCanvasElement): Quad | null {
  try {
    const contour = scanner.findPaperContour(window.cv);
    // jscanify's API reads an image via cv.imread(canvas); wrap so a detection miss is a
    // null rather than an exception that kills the animation loop.
    const cv = window.cv as { imread(c: HTMLCanvasElement): { delete(): void } };
    const img = cv.imread(canvas);
    try {
      const found = scanner.findPaperContour(img);
      if (!found) return null;
      const q = scanner.getCornerPoints(found, img);
      if (!q || !isSaneQuad(q, canvas.width, canvas.height)) return null;
      return q;
    } finally {
      img.delete(); // OpenCV.js is manual-memory; a leaked Mat per frame exhausts WASM heap
    }
  } catch {
    return null;
  }
}

/** Rejects degenerate detections — a quad that is nearly the whole frame usually means it
 * locked onto the frame border, and a tiny one is noise. Showing either is worse than
 * showing nothing, because the user trusts the overlay. */
function isSaneQuad(q: Quad, w: number, h: number): boolean {
  const pts = [q.topLeftCorner, q.topRightCorner, q.bottomRightCorner, q.bottomLeftCorner];
  if (pts.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  // Shoelace area.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  const frac = Math.abs(area / 2) / (w * h);
  return frac > 0.12 && frac < 0.98;
}

/** Scales a quad detected at one resolution up to another (detect small, warp large). */
export function scaleQuad(q: Quad, factor: number): Quad {
  const s = (c: Corner): Corner => ({ x: c.x * factor, y: c.y * factor });
  return {
    topLeftCorner: s(q.topLeftCorner),
    topRightCorner: s(q.topRightCorner),
    bottomLeftCorner: s(q.bottomLeftCorner),
    bottomRightCorner: s(q.bottomRightCorner),
  };
}

export { DETECT_WIDTH, DETECT_INTERVAL_MS };

/** Longest edge of a captured page, in pixels. Plenty for OCR; small enough that a 40-page
 * scan is a few MB rather than a few hundred. */
const OUTPUT_LONG_EDGE = 1600;
const JPEG_QUALITY = 0.82;

export interface Page {
  id: string;
  /** JPEG bytes, perspective-corrected. */
  blob: Blob;
  /** object URL for the thumbnail; revoke when the page is dropped. */
  url: string;
  width: number;
  height: number;
}

/** Warps the detected quad to a flat rectangle and encodes it. Falls back to the raw frame
 * when no quad was found, so a capture never silently fails — a slightly skewed page still
 * beats nothing. */
export async function capturePage(
  scanner: JScanify,
  frame: HTMLCanvasElement,
  quad: Quad | null,
): Promise<Page> {
  let out: HTMLCanvasElement = frame;
  if (quad) {
    const w = dist(quad.topLeftCorner, quad.topRightCorner);
    const h = dist(quad.topLeftCorner, quad.bottomLeftCorner);
    if (w > 32 && h > 32) {
      try {
        out = scanner.extractPaper(frame, Math.round(w), Math.round(h), quad);
      } catch {
        out = frame;
      }
    }
  }
  const scaled = downscale(out, OUTPUT_LONG_EDGE);
  const blob = await new Promise<Blob>((resolve, reject) =>
    scaled.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", JPEG_QUALITY),
  );
  return {
    id: crypto.randomUUID(),
    blob,
    url: URL.createObjectURL(blob),
    width: scaled.width,
    height: scaled.height,
  };
}

function dist(a: Corner, b: Corner): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function downscale(src: HTMLCanvasElement, longEdge: number): HTMLCanvasElement {
  const long = Math.max(src.width, src.height);
  if (long <= longEdge) return src;
  const k = longEdge / long;
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Joins pages into one PDF, client-side.
 *
 * Client-side on purpose: "one receipt" and "a 40-page contract" become the same code path,
 * the user sees exactly what they are sending before it goes, and the gateway receives one
 * upload instead of forty. If a SEARCHABLE pdf is wanted, the agent runs ocrmypdf on
 * arrival — the client makes the visual document, the agent enriches it. */
export async function buildPdf(pages: Page[]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const img = await doc.embedJpg(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return doc.save();
}
