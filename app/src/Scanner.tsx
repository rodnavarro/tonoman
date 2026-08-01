import { useCallback, useEffect, useRef, useState } from "react";
import {
  DETECT_INTERVAL_MS,
  DETECT_WIDTH,
  capturePage,
  detectQuad,
  loadScanner,
  scaleQuad,
  type Page,
  type Quad,
} from "./scan";

interface Props {
  onDone: (pages: Page[]) => void;
  onCancel: () => void;
}

/** Live document scanner: viewfinder with an edge overlay, per-page confirm, filmstrip. */
export function Scanner({ onDone, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scannerRef = useRef<Awaited<ReturnType<typeof loadScanner>> | null>(null);
  const quadRef = useRef<Quad | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState("Starting camera…");
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [preview, setPreview] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- camera + detection loop ---------------------------------------------
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let dead = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // The rear camera, and a high request so the final warp has pixels to work with.
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (dead) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        // iOS refuses to play inline without both of these set before play().
        v.setAttribute("playsinline", "true");
        v.muted = true;
        await v.play();

        setStatus("Loading edge detection…");
        scannerRef.current = await loadScanner();
        if (dead) return;
        setReady(true);
        setStatus("Point at the document");

        const work = document.createElement("canvas");
        const loop = (t: number) => {
          raf = requestAnimationFrame(loop);
          if (t - last < DETECT_INTERVAL_MS) return;
          last = t;
          const vid = videoRef.current;
          const ov = overlayRef.current;
          if (!vid || !ov || !vid.videoWidth || !scannerRef.current) return;

          // Detect on a downscaled copy — see scan.ts note 2.
          const k = DETECT_WIDTH / vid.videoWidth;
          work.width = DETECT_WIDTH;
          work.height = Math.round(vid.videoHeight * k);
          work.getContext("2d")!.drawImage(vid, 0, 0, work.width, work.height);
          const q = detectQuad(scannerRef.current, work);
          quadRef.current = q ? scaleQuad(q, 1 / k) : null;

          // Overlay is sized to the DISPLAYED video box, not the sensor, so the outline
          // lands where the user actually sees the page.
          const rect = vid.getBoundingClientRect();
          if (ov.width !== rect.width || ov.height !== rect.height) {
            ov.width = rect.width;
            ov.height = rect.height;
          }
          drawOverlay(ov, q, work.width, work.height);
          setLocked(Boolean(q));
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        setError(
          /NotAllowed|Permission/i.test(msg)
            ? "Camera permission denied. On iPhone, open this page in Safari (not from the Home Screen icon) and allow the camera."
            : `Camera unavailable: ${msg}`,
        );
      }
    })();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // --- capture -------------------------------------------------------------
  const shoot = useCallback(async () => {
    const v = videoRef.current;
    const sc = scannerRef.current;
    if (!v || !sc) return;
    setStatus("Processing…");
    const frame = document.createElement("canvas");
    frame.width = v.videoWidth;
    frame.height = v.videoHeight;
    frame.getContext("2d")!.drawImage(v, 0, 0);
    try {
      // The warp runs on the FULL-resolution frame; only detection was downscaled.
      const page = await capturePage(sc, frame, quadRef.current);
      setPreview(page);
    } catch (e) {
      setError(`Could not process that shot: ${(e as Error).message}`);
    } finally {
      setStatus("Point at the document");
    }
  }, []);

  const acceptPage = () => {
    if (!preview) return;
    setPages((p) => [...p, preview]);
    setPreview(null);
  };
  const retake = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };
  const removePage = (id: string) =>
    setPages((p) => {
      const gone = p.find((x) => x.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return p.filter((x) => x.id !== id);
    });

  if (error) {
    return (
      <div className="scanner error-pane">
        <p className="error">{error}</p>
        <button onClick={onCancel}>Back</button>
      </div>
    );
  }

  return (
    <div className="scanner">
      <div className="viewfinder">
        <video ref={videoRef} playsInline muted />
        <canvas ref={overlayRef} className="overlay" />
        {!ready && <div className="scrim">{status}</div>}
        {ready && <div className={`hint ${locked ? "locked" : ""}`}>{locked ? "Page detected" : status}</div>}
      </div>

      {preview && (
        <div className="preview">
          <img src={preview.url} alt="Captured page" />
          <div className="row">
            <button onClick={retake}>Retake</button>
            <button className="primary" onClick={acceptPage}>
              Use this page
            </button>
          </div>
        </div>
      )}

      {!preview && (
        <>
          {pages.length > 0 && (
            <div className="filmstrip">
              {pages.map((p, i) => (
                <div key={p.id} className="thumb">
                  <img src={p.url} alt={`Page ${i + 1}`} />
                  <span className="n">{i + 1}</span>
                  <button className="x" onClick={() => removePage(p.id)} aria-label={`Remove page ${i + 1}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="controls">
            <button onClick={onCancel}>Cancel</button>
            <button className="shutter" onClick={shoot} disabled={!ready} aria-label="Capture page" />
            <button className="primary" disabled={pages.length === 0} onClick={() => onDone(pages)}>
              Send{pages.length > 0 ? ` (${pages.length})` : ""}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Paints the detected outline, mapping detection-space coords onto the displayed box. */
function drawOverlay(canvas: HTMLCanvasElement, q: Quad | null, srcW: number, srcH: number): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!q) return;
  const kx = canvas.width / srcW;
  const ky = canvas.height / srcH;
  const pts = [q.topLeftCorner, q.topRightCorner, q.bottomRightCorner, q.bottomLeftCorner];
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = p.x * kx;
    const y = p.y * ky;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(56, 189, 248, 0.18)";
  ctx.fill();
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 3;
  ctx.stroke();
}
