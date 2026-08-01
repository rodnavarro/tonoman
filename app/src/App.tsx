import { useCallback, useEffect, useRef, useState } from "react";
import { CloudApi, GatewayApi, type ChatEvent, type FleetAgent, type FleetGateway } from "./api";
import { completeLogin, current, loadConfig, login, logout, type OidcConfig, type Session } from "./auth";
import { Scanner } from "./Scanner";
import { buildPdf, type Page } from "./scan";

type View = { kind: "fleet" } | { kind: "chat"; gw: FleetGateway; agent: FleetAgent };

interface Bubble {
  id: string;
  role: "user" | "agent";
  text: string;
  pending?: boolean;
}

export function App() {
  const [cfg, setCfg] = useState<OidcConfig | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "fleet" });

  useEffect(() => {
    (async () => {
      try {
        const c = await loadConfig();
        setCfg(c);
        setSession((await completeLogin(c)) ?? current());
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  if (error) return <Shell><p className="error">{error}</p></Shell>;
  if (!cfg) return <Shell><p className="muted">Loading…</p></Shell>;
  if (!session)
    return (
      <Shell>
        <div className="signin">
          <h1>Tonoman</h1>
          <p className="muted">Your agents, wherever they run.</p>
          <button className="primary big" onClick={() => login(cfg)}>
            Sign in
          </button>
        </div>
      </Shell>
    );

  return view.kind === "fleet" ? (
    <Fleet session={session} onOpen={(gw, agent) => setView({ kind: "chat", gw, agent })} />
  ) : (
    <Chat session={session} gw={view.gw} agent={view.agent} onBack={() => setView({ kind: "fleet" })} />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="shell">{children}</div>;
}

function Fleet({ session, onOpen }: { session: Session; onOpen: (gw: FleetGateway, a: FleetAgent) => void }) {
  const [gateways, setGateways] = useState<FleetGateway[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    new CloudApi(session.accessToken)
      .fleet()
      .then((f) => setGateways(f.gateways))
      .catch((e) => setError(e.message));
  }, [session]);

  return (
    <Shell>
      <header>
        <h1>Your fleet</h1>
        <button className="link" onClick={logout}>
          Sign out
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {!gateways && !error && <p className="muted">Loading…</p>}
      {gateways?.length === 0 && <p className="muted">No gateways yet.</p>}
      {gateways?.map((gw) => (
        <section key={gw.id} className="gw">
          <div className="gw-head">
            <span className={`dot ${gw.status}`} />
            <strong>{gw.name}</strong>
            <span className="tag">{gw.hosting === "cloud" ? "cloud" : "self-hosted"}</span>
          </div>
          {gw.agents.map((a) => (
            <button
              key={a.id}
              className="agent"
              disabled={!gw.endpointUrl}
              onClick={() => onOpen(gw, a)}
              title={gw.endpointUrl ? undefined : "This gateway is not directly reachable yet"}
            >
              <span className="name">{a.name}</span>
              <span className="role">{a.role ?? a.harness}</span>
            </button>
          ))}
          {gw.agents.length === 0 && <p className="muted small">No agents reported.</p>}
        </section>
      ))}
    </Shell>
  );
}

function Chat({
  session,
  gw,
  agent,
  onBack,
}: {
  session: Session;
  gw: FleetGateway;
  agent: FleetAgent;
  onBack: () => void;
}) {
  const [api, setApi] = useState<GatewayApi | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // One conversation per agent, stable across reloads so the agent keeps its memory.
  const conversation = `app-${agent.id}`;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles, working]);

  // Mint a gateway-scoped token, then open the stream. Both live for this view only.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const { token, endpointUrl } = await new CloudApi(session.accessToken).gatewayToken(gw.id);
        const g = new GatewayApi(endpointUrl, token);
        setApi(g);
        for await (const ev of g.stream(conversation, ac.signal)) applyEvent(ev, setBubbles, setWorking);
      } catch (e) {
        if (!ac.signal.aborted) setError((e as Error).message);
      }
    })();
    return () => ac.abort();
  }, [session, gw.id, conversation]);

  const send = useCallback(
    async (body: string, mediaPaths: string[] = [], label?: string) => {
      if (!api) return;
      setBusy(true);
      try {
        setBubbles((b) => [...b, { id: crypto.randomUUID(), role: "user", text: label ?? body }]);
        await api.send(conversation, body, mediaPaths);
        setText("");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [api, conversation],
  );

  /** Assembles the scanned pages into one PDF, uploads it, and sends it as a normal turn.
   * The agent needs no change — this lands on the shared mount exactly like a Telegram
   * photo, and arrives as Envelope.mediaPaths. */
  const onScanned = useCallback(
    async (pages: Page[]) => {
      setScanning(false);
      if (!api || pages.length === 0) return;
      setBusy(true);
      setWorking("Building PDF…");
      try {
        const pdf = await buildPdf(pages);
        setWorking("Uploading…");
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const path = await api.uploadMedia(new Blob([pdf as BlobPart], { type: "application/pdf" }), `scan-${stamp}.pdf`);
        pages.forEach((p) => URL.revokeObjectURL(p.url));
        const noun = pages.length === 1 ? "page" : "pages";
        await send(
          `I scanned a document (${pages.length} ${noun}). It's attached as a PDF — please take a look and handle it.`,
          [path],
          `📄 Scanned ${pages.length} ${noun}`,
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setWorking(null);
        setBusy(false);
      }
    },
    [api, send],
  );

  if (scanning) return <Scanner onDone={onScanned} onCancel={() => setScanning(false)} />;

  return (
    <Shell>
      <header>
        <button className="link" onClick={onBack}>
          ← Fleet
        </button>
        <h1>{agent.name}</h1>
        <span />
      </header>
      {error && <p className="error">{error}</p>}
      <div className="thread">
        {bubbles.map((b) => (
          <div key={b.id} className={`bubble ${b.role}`}>
            {b.text}
            {b.pending && <span className="cursor">▍</span>}
          </div>
        ))}
        {working && <div className="working">{working}</div>}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <button className="scan" onClick={() => setScanning(true)} disabled={!api || busy} aria-label="Scan a document">
          📄
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && text.trim() && send(text)}
          placeholder={api ? `Message ${agent.name}…` : "Connecting…"}
          disabled={!api || busy}
        />
        <button className="primary" disabled={!api || busy || !text.trim()} onClick={() => send(text)}>
          Send
        </button>
      </div>
    </Shell>
  );
}

/** Folds one SSE event into the thread. `message` opens a bubble, `update` edits it in
 * place, `final` settles it — the same progressive-edit model Telegram gets. */
function applyEvent(
  ev: ChatEvent,
  setBubbles: React.Dispatch<React.SetStateAction<Bubble[]>>,
  setWorking: (s: string | null) => void,
): void {
  if (ev.type === "working") return setWorking(ev.status || "Working…");
  if (ev.type === "settled") return setWorking(null);
  if (ev.type === "note") return; // standalone notices (queue footer) — not part of the thread
  if (!ev.id) return;
  const text = ev.text ?? "";
  setBubbles((b) => {
    const i = b.findIndex((x) => x.id === ev.id);
    const next: Bubble = { id: ev.id!, role: "agent", text, pending: ev.type !== "final" };
    if (i < 0) return [...b, next];
    const copy = [...b];
    copy[i] = next;
    return copy;
  });
  if (ev.type === "final") setWorking(null);
}
