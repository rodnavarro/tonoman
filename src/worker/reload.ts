// The roster diff behind live reload (A11, hot-reload).
//
// The worker reads its roster once at boot and then never again, so every Hub edit — a renamed
// agent, a new default model, a granted skill — reached the running agent only on a restart. This
// computes what changed between the roster the worker is serving and the one it just re-fetched, so
// the worker can apply the difference in place instead of being bounced.
//
// PURE on purpose. It touches no connector, no schedule, no socket — it only classifies, so the one
// property that actually matters can be tested without standing anything up: that a change which
// does NOT touch a connector's inputs is never classified as one that rebuilds the connector.
// Rebuilding a live Slack connector reconnects its Socket Mode socket, and Slack delivers each event
// to exactly one connection holding the app token — so a needless rebuild on every reload would drop
// messages and read as a flaky bug. The negative case is the regression a future edit is most likely
// to reintroduce, which is why it is the test worth writing.

import type { AgentConfig } from "../config.js";

export interface AgentDelta {
  /** The agent's stable key — its guid on a registry roster, its name on a file roster. The same
   *  key the worker's `wired` map uses. */
  key: string;
  /** Rebuild the connector — and with it the runner and the ingress pump — because one of the
   *  connector's OWN inputs changed: the harness, the channel, either Slack token, or the
   *  allowed-users list. This is the only classification that reconnects a socket, so it is reserved
   *  for changes a socket actually depends on. Rare in practice: a token rotation or a channel move. */
  rebuildConn: boolean;
  /** Rebuild the runner while KEEPING the live connector (no reconnect): a field the harness bakes in
   *  at construction and does not re-read per turn changed. `max_turns` is the one a person edits on
   *  the Hub form and watches for; `url` (a remote runtime) is another; `inference_mode` a third (the
   *  run closure captures it). Everything else the runner needs — the model, the identity file — is
   *  read per turn, so a config swap alone carries it. */
  rebuildRunner: boolean;
}

export interface ReloadPlan {
  /** Keys in the new roster and not the old — a created agent, or one that just became servable
   *  (enabled, or finished its Slack setup: the roster only lists enabled, channel-bound agents). */
  added: string[];
  /** Keys in the old roster and not the new — a deleted or disabled agent, or one whose channel was
   *  turned off. Its connector is stopped and its voice schedule paused. */
  removed: string[];
  /** Keys in both, whose config actually differs. Everything unchanged is absent, so a reload with
   *  no Hub edits produces an empty plan and touches nothing. */
  updated: AgentDelta[];
}

/** The stable key the `wired` map is keyed by. `name` is the guid on a registry roster and the
 *  agent's name on a file roster — either way it is what never changes under a rename. */
function keyOf(a: AgentConfig): string {
  return a.name;
}

/** What changed between the roster in service (`oldCfgs`) and the one just fetched (`newCfgs`).
 *
 *  Config equality is a deep compare of the whole agent object: the control plane builds each field
 *  the same way every time, so an unchanged agent stringifies identically and drops out of the plan.
 *  The identity TEXT is not in the config — it is written to a file at a stable path on every roster
 *  fetch — so an identity-only edit reaches the agent through that file whether or not it shows up
 *  here; the diff is about the connector, runner and voice wiring, which config does describe. */
export function planReload(oldCfgs: AgentConfig[], newCfgs: AgentConfig[]): ReloadPlan {
  const oldByKey = new Map(oldCfgs.map((a) => [keyOf(a), a]));
  const newByKey = new Map(newCfgs.map((a) => [keyOf(a), a]));

  const added: string[] = [];
  const removed: string[] = [];
  const updated: AgentDelta[] = [];

  for (const [key, next] of newByKey) {
    const prev = oldByKey.get(key);
    if (!prev) {
      added.push(key);
      continue;
    }
    if (JSON.stringify(prev) === JSON.stringify(next)) continue; // unchanged — nothing to do

    const rebuildConn =
      (prev.harness ?? "") !== (next.harness ?? "") ||
      (prev.channel ?? "") !== (next.channel ?? "") ||
      (prev.slack?.bot_token ?? "") !== (next.slack?.bot_token ?? "") ||
      (prev.slack?.app_token ?? "") !== (next.slack?.app_token ?? "") ||
      JSON.stringify(prev.slack?.allowed_users ?? null) !== JSON.stringify(next.slack?.allowed_users ?? null);

    const rebuildRunner =
      rebuildConn ||
      (prev.max_turns ?? 0) !== (next.max_turns ?? 0) ||
      (prev.url ?? "") !== (next.url ?? "") ||
      // The run closure captures `inference_mode` (it decides per turn whether to use the speaker's
      // own credential), so a change to it has to remake the closure — a plain cfg swap would leave
      // the old mode answering. Treated like `max_turns`: rebuild the runner, keep the connector.
      (prev.inference_mode ?? "shared") !== (next.inference_mode ?? "shared");

    updated.push({ key, rebuildConn, rebuildRunner });
  }

  for (const key of oldByKey.keys()) {
    if (!newByKey.has(key)) removed.push(key);
  }

  return { added, removed, updated };
}
