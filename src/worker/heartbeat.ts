// A pool says it is alive, and which release it runs (POOL-HEARTBEATS, worker-pool.md in Tonoman
// Cloud). Only a worker holding a POOL credential heartbeats: the platform's own fleet does not.

/** A pool credential is recognisable by its prefix; the platform token is not one. */
export function isPoolCredential(token: string | undefined): boolean {
  return !!token && token.startsWith("tpc_");
}

export interface HeartbeatOptions {
  baseUrl: string;
  token: string;
  version: string;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Called when the platform says this release is no longer served (POOL-RUNS-THE-SAME-IMAGE). */
  onOutdated?: (releases: { current: string; previous: string }) => void;
}

/** One beat: PUT /v1/pool/heartbeat. Returns what the platform answered, or the failure. Never throws. */
export async function beat(o: HeartbeatOptions): Promise<{ ok: true; outdated: boolean; releases: { current: string; previous: string } } | { ok: false; why: string }> {
  const f = o.fetchImpl ?? globalThis.fetch;
  try {
    const r = await f(`${o.baseUrl.replace(/\/+$/, "")}/v1/pool/heartbeat`, {
      method: "PUT",
      headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: o.version }),
    });
    if (r.status === 401) return { ok: false, why: "the platform no longer accepts this pool's credential (revoked?)" };
    if (!r.ok) return { ok: false, why: `http ${r.status}` };
    const j = (await r.json()) as { outdated?: boolean; releases?: { current: string; previous: string } };
    return { ok: true, outdated: !!j.outdated, releases: j.releases ?? { current: "", previous: "" } };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

/** Beat now and every minute. Says so once when a beat starts failing and once when it recovers, and
 *  once when the release is outdated — a log that repeats the same line every minute is unread. */
export function startHeartbeat(o: HeartbeatOptions): () => void {
  const log = o.log ?? ((l) => console.log(l));
  let failing = false;
  let saidOutdated = false;
  const tick = async (): Promise<void> => {
    const r = await beat(o);
    if (!r.ok) {
      if (!failing) log(`worker: heartbeat failed — ${r.why}`);
      failing = true;
      return;
    }
    if (failing) log("worker: heartbeat back");
    failing = false;
    if (r.outdated && !saidOutdated) {
      saidOutdated = true;
      log(`worker: this release (${o.version}) is no longer served — current is ${r.releases.current}${r.releases.previous ? `, previous ${r.releases.previous}` : ""}; run tonomanctl update`);
      o.onOutdated?.(r.releases);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), o.intervalMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
