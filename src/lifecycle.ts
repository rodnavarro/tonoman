// Agent sandbox lifecycle (cli-up-down). The gateway owns its workloads: on `up` it
// brings each agent's container up, on shutdown (`tonoman down` / Ctrl-C) it stops them.
//
// SAFETY FLOOR — adopt, never destroy. These helpers only `start` and `stop` an
// existing container; they NEVER `rm` or recreate one, so a down/up cycle never loses
// an agent's config volume, creds, or memory (stop ≠ rm). Creating a container that
// doesn't exist yet is provisioning (roster-provision / `tonoman create agent`), a
// separate, deliberate step — not something `up` does implicitly.

import { execFile } from "node:child_process";

const PODMAN = "podman";

function podman(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(PODMAN, args, { windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

/** A container's state by name. A missing container / inspect error reads as "absent". */
export async function containerState(name: string): Promise<"running" | "stopped" | "absent"> {
  const r = await podman(["inspect", "-f", "{{.State.Running}}", name]);
  if (r.code !== 0) return "absent";
  return r.stdout.trim() === "true" ? "running" : "stopped";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Adopt-safe bring-up: start an existing-but-stopped container; no-op if already
 * running. Returns what it found/did. Does NOT create — an absent container is
 * reported, not provisioned (that is `tonoman create agent`, roster-provision).
 *
 * Tolerates the down→up RACE: a container caught mid-`stop` reports Running=false but
 * isn't yet in a startable state ("container … must be in Created or Stopped state"),
 * so `podman start` fails transiently. We retry past that until it finishes stopping
 * (bounded), instead of failing the whole `up`. */
export async function ensureStarted(name: string, deadlineMs = 20000): Promise<"running" | "started" | "absent"> {
  const s = await containerState(name);
  if (s === "running") return "running";
  if (s === "absent") return "absent";
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const r = await podman(["start", name]);
    if (r.code === 0) return "started";
    const msg = r.stderr.toLowerCase();
    const transient = msg.includes("improper") || msg.includes("must be in") || msg.includes("stopping");
    if (!transient || Date.now() > deadline) throw new Error(`podman start ${name}: ${r.stderr.trim() || `exit ${r.code}`}`);
    await sleep(500); // container still settling from a stop — let it reach Stopped, then retry
  }
}

/** Stop a running container gracefully. No-op (returns false) if it isn't running.
 * Never removes the container — volumes/creds persist for the next `up`. */
export async function stopContainer(name: string): Promise<boolean> {
  const s = await containerState(name);
  if (s !== "running") return false;
  const r = await podman(["stop", name]);
  if (r.code !== 0) throw new Error(`podman stop ${name}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return true;
}

/** Adopt-safe CREATE (roster-provision): run a NEW container from an assembled `podman
 * run …` argv ONLY if no container of that name exists. If one already exists — running
 * OR stopped — it is LEFT UNTOUCHED and `false` is returned; this never `rm`s or
 * recreates (the SAFETY FLOOR), so `create agent` can't clobber a live agent. Returns
 * true when it created one. `runArgs` is what podmanRunArgs() produced (starts with "run"). */
export async function createIfAbsent(name: string, runArgs: string[]): Promise<boolean> {
  const s = await containerState(name);
  if (s !== "absent") return false;
  const r = await podman(runArgs);
  if (r.code !== 0) throw new Error(`podman run ${name}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return true;
}
