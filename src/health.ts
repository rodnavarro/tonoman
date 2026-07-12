// Tonoman's substrate observability (A12). It collects the health of the
// non-container substrate services (control channel, memory) and the agents into
// one snapshot that the gateway serves over a small local HTTP API and
// `tonoman get services` renders. Each subsystem registers a Check; the registry runs
// them all on demand — a new service shows up just by registering a check.

import * as http from "node:http";

export type Status = "ok" | "degraded" | "down" | "unknown";

/** One line of the health report. */
export interface Service {
  name: string; // e.g. "control", "memory", "container"
  kind: string; // "substrate" | "agent"
  agent?: string; // owning agent, when applicable
  status: Status;
  detail?: string; // short human note
}

/** Reports the current health of one service. Must never throw. */
export type Check = (signal: AbortSignal) => Promise<Service> | Service;

/** The full snapshot the API returns and the CLI renders. */
export interface Report {
  overall: Status;
  services: Service[];
}

/** Holds the registered checks. */
export class Registry {
  private checks: Check[] = [];

  add(c: Check): void {
    this.checks.push(c);
  }

  /** Runs every check and returns a sorted report (substrate first, then agent, then name). */
  async snapshot(signal: AbortSignal): Promise<Report> {
    const services = await Promise.all(this.checks.map((c) => Promise.resolve(c(signal))));
    const kindRank = (k: string): number => (k === "substrate" ? 0 : 1); // substrate before agent
    services.sort((a, b) => {
      if (a.kind !== b.kind) return kindRank(a.kind) - kindRank(b.kind);
      if ((a.agent ?? "") !== (b.agent ?? "")) return (a.agent ?? "").localeCompare(b.agent ?? "");
      return a.name.localeCompare(b.name);
    });
    return { overall: overall(services), services };
  }
}

/** Worst status across services: down > degraded > unknown > ok. Empty = ok. */
function overall(services: Service[]): Status {
  const rank: Record<Status, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };
  let worst: Status = "ok";
  for (const s of services) if (rank[s.status] > rank[worst]) worst = s.status;
  return worst;
}

/** Runs the health API on addr (loopback) until the signal aborts. `onListen` (if
 * given) receives the actually-bound port once listening — handy for tests that bind
 * an ephemeral port (addr ":0"). */
export function serve(
  addr: string,
  reg: Registry,
  signal: AbortSignal,
  onListen?: (port: number) => void,
  onShutdown?: () => void,
  /** Loopback admin: switch an agent's auth backend live (backend-switch-live). Called with the
   * POSTed { agent, backend } — returns a result to send back. Operator-only by virtue of the
   * server binding loopback (a channel user can never reach it). */
  onBackend?: (agent: string, backend?: string) => { ok: boolean; msg: string },
): Promise<void> {
  const { host, port } = splitAddr(addr);
  const server = http.createServer((req, res) => {
    // Loopback admin endpoint: `tonoman down` POSTs here to stop the plane gracefully
    // (cli-up-down). Loopback-only (the server binds 127.0.0.1), so it is not exposed.
    if (req.method === "POST" && req.url === "/shutdown") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stopping: true }));
      onShutdown?.();
      return;
    }
    // Loopback admin endpoint: `tonoman backend <agent> <mode>` POSTs here to switch an agent's
    // auth backend live (backend-switch-live / backend-operator-only). Loopback-only.
    if (req.method === "POST" && req.url === "/backend") {
      let buf = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        let body: { agent?: string; backend?: string } = {};
        try {
          body = JSON.parse(buf || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, msg: "bad json" }));
          return;
        }
        const r = onBackend
          ? onBackend(body.agent ?? "", body.backend)
          : { ok: false, msg: "backend switching not supported" };
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      });
      return;
    }
    if (!req.url || !req.url.startsWith("/health")) {
      res.writeHead(404).end();
      return;
    }
    const ac = new AbortController();
    reg
      .snapshot(ac.signal)
      .then((rep) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rep));
      })
      .catch(() => res.writeHead(500).end());
  });

  return new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      onListen?.((server.address() as { port: number }).port);
      signal.addEventListener("abort", () => server.close(() => resolve()), { once: true });
    });
  });
}

/** Queries a running gateway's health API and returns the report. */
export async function fetchReport(addr: string): Promise<Report> {
  const url = `http://${addr}/health`;
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    throw new Error(`gateway not reachable at ${addr} (is it running?): ${(e as Error).message}`);
  }
  if (!resp.ok) throw new Error(`health API returned ${resp.status}`);
  return (await resp.json()) as Report;
}

/** Writes the report as an aligned table. */
export function render(rep: Report): string {
  const rows = [
    ["KIND", "AGENT", "SERVICE", "STATUS", "DETAIL"],
    ...rep.services.map((s) => [s.kind, s.agent || "-", s.name, s.status, s.detail || ""]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  return lines.join("\n") + `\n\noverall: ${rep.overall}\n`;
}

function splitAddr(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(":");
  if (i < 0) return { host: "127.0.0.1", port: Number(addr) };
  return { host: addr.slice(0, i) || "127.0.0.1", port: Number(addr.slice(i + 1)) };
}
