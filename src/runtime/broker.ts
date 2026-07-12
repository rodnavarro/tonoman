// The A13 broker: the host-side executor that sits between an agent's podman
// client and the real, rootless, non-privileged host podman. It is the only place
// that touches the host container engine. The flow is always:
//
//   agent argv  →  authorize(policy, argv)  →  spawn host podman (rewritten argv)
//
// authorize() (runtime/policy) is pure and is where allow/deny + path rewrite +
// namespacing live; this module adds process execution, secret injection
// host-side (the agent never holds secrets), and output streaming. Keeping exec
// here and policy pure means the security decision is unit-tested independently of
// any podman being installed.

import { spawn } from "node:child_process";
import { authorize, DenyError, type Policy } from "./policy";

export interface BrokerOptions {
  /** host podman binary; default "podman". */
  podmanBin?: string;
  /**
   * Secrets to inject host-side as `-e KEY=VALUE` for `run`/`create` (and as
   * `--env KEY=VALUE` style is left to the caller). The agent never sees values:
   * it requests a run; the broker adds the env. Only applied to run/create verbs.
   */
  secrets?: Record<string, string>;
  /** when set, stamp `--label <agentLabel>` on container-creating verbs (run/create)
   * so brokered containers carry their owning agent (e.g. "tonoman.agent=<guid>").
   * Lets `tonoman url/expose` scope to an agent's own containers (A11 isolation). */
  agentLabel?: string;
  /** extra environment for the spawned podman process itself (e.g. CONTAINERS_*). */
  env?: NodeJS.ProcessEnv;
  /** working directory for the spawned process. */
  cwd?: string;
  /** input piped to the host command's stdin. When omitted, stdin is closed (EOF)
   * immediately, so an `-i`/interactive command (e.g. `psql`) gets EOF and returns
   * instead of hanging forever waiting for input — the live-migration hang. */
  stdin?: string;
  /** kill the host command and return a timeout result after this many ms. Defaults
   * to a generous bound (long builds/restores); the broker never lets an op hang
   * unbounded (which previously orphaned work past the shim's 10-min ceiling). */
  timeoutMs?: number;
  /** if set, receives stdout/stderr chunks as they arrive (for live streaming). */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** cancellation: kills the spawned podman when aborted. */
  signal?: AbortSignal;
  /** test seam: injected spawn (defaults to child_process.spawn). */
  _spawn?: typeof spawn;
}

export interface BrokerResult {
  /** the authorized argv: post path-rewrite/namespacing, PRE secret injection. This
   * is the audit-safe argv — it can never contain an injected secret, so it is what
   * the ledger logs. */
  authorizedArgv: string[];
  /** the argv actually handed to host podman (authorized + injected `-e KEY=VALUE`).
   * May contain secret VALUES — NEVER log, persist, or surface this. */
  executedArgv: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  /** true when the broker killed the op because it exceeded its timeout. */
  timedOut?: boolean;
}

// Verbs that accept `-e KEY=VAL` env injection. Secrets are only added for these.
const ENV_INJECTABLE = new Set(["run", "create"]);

// Default timeout: generous enough for a real image build or DB restore, but well
// under the in-container shim's 10-min ceiling so the broker returns a clean error
// first instead of the op hanging and being abandoned.
const DEFAULT_TIMEOUT_MS = 480_000;

/**
 * Authorizes an agent podman command and runs it on the host podman, streaming
 * output. Rejects with a DenyError (without spawning anything) if the policy
 * refuses the command — the broker never runs a denied command.
 */
export function brokerRun(
  policy: Policy,
  agentArgv: string[],
  opts: BrokerOptions = {},
): Promise<BrokerResult> {
  // 1. Security decision (pure). Throws DenyError on refusal — before any spawn.
  const rewritten = authorize(policy, agentArgv);

  // 2. Host-side secret injection: the agent requested a run; the broker supplies
  //    the credentials. Inserted right after the verb so they precede the image.
  const verb = rewritten[0];
  const secrets = opts.secrets ?? {};
  let finalArgv = rewritten;
  if (ENV_INJECTABLE.has(verb)) {
    const inject: string[] = [];
    for (const [k, v] of Object.entries(secrets)) inject.push("-e", `${k}=${v}`);
    if (opts.agentLabel) inject.push("--label", opts.agentLabel); // ownership stamp (A11)
    if (inject.length > 0) finalArgv = [verb, ...inject, ...rewritten.slice(1)];
  }

  const bin = opts.podmanBin ?? "podman";
  const spawnFn = opts._spawn ?? spawn;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise<BrokerResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("brokerRun: aborted before start"));
      return;
    }
    const child = spawnFn(bin, finalArgv, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
    });

    // Feed stdin then close it — or close it immediately when none is piped. Never
    // leave stdin open: an `-i` command with no input would block forever.
    try {
      if (child.stdin) {
        if (opts.stdin) child.stdin.write(opts.stdin);
        child.stdin.end();
      }
    } catch {
      /* stdin may already be closed; ignore */
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM"); // its 'close' will settle the promise as a timeout
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr += s;
      opts.onStderr?.(s);
    });

    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        resolve({
          authorizedArgv: rewritten,
          executedArgv: finalArgv,
          code: code ?? 124, // conventional timeout exit code
          stdout,
          stderr: stderr + `\n[broker] killed: command timed out after ${timeoutMs}ms`,
          timedOut: true,
        });
        return;
      }
      resolve({ authorizedArgv: rewritten, executedArgv: finalArgv, code, stdout, stderr });
    });
  });
}

export { DenyError };
