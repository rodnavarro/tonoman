// The A8 control channel, generalized into the runtime broker seam. An agent runs
// in a sandbox with no host networking; the one thing it shares with the host is
// its memory mount. So the agent→host runtime request travels as files on that
// mount: the agent's `podman` shim writes a request, the host broker authorizes +
// executes it (runtime/broker), and writes the response back. No host↔container
// socket needed — robust on Windows/WSL, which is why the original create-tunnel
// channel used the same file-based mechanism.
//
// Transport contract (one directory per agent, on the memory mount):
//   <dir>/requests/<id>.json   {"id","argv":[...]}        written by the agent
//   <dir>/responses/<id>.json  {"id","code","stdout",...} written by the broker
// Both sides write to <name>.tmp then rename, so a reader never sees a partial file.

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { brokerRun, DenyError, type BrokerOptions } from "./broker";
import { mapCwdToHost, type Policy } from "./policy";
import { TONOMAN_BUILTIN, type TonomanResult } from "./expose";
import type { Ledger } from "./ledger";

export interface ControlRequest {
  id: string;
  argv: string[];
  /** the agent's working directory (sandbox view); mapped to a host path so
   * `cd <project> && podman compose up` resolves files host-side. */
  cwd?: string;
  /** input piped to the command's stdin (e.g. `… | podman exec -i pg psql`). The
   * broker feeds it to the host process; absent → stdin is closed (EOF). */
  stdin?: string;
}

export interface ControlResponse {
  id: string;
  /** process exit code, or null if it was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** true when the policy refused the command (nothing was executed). */
  denied?: boolean;
  /** human-readable failure (policy denial reason, or a spawn error). */
  error?: string;
  /** the authorized argv actually run (post path-rewrite, PRE secret injection) —
   * audit-safe, never contains an injected secret. Used by the ledger. */
  authorizedArgv?: string[];
}

/** Executes an authorized agent argv (with the agent's cwd and optional stdin). The
 * real one wraps brokerRun; tests inject a fake. */
export type Executor = (argv: string[], cwd?: string, stdin?: string) => Promise<ControlResponse>;

/** Handles a `tonoman` builtin invocation (argv after the sentinel) host-side —
 * url/expose/unexpose. Wired by the gateway to an ExposeManager. */
export type TonomanHandler = (args: string[]) => Promise<TonomanResult>;

/** Builds the production executor: dispatch the `tonoman` builtin to its handler;
 * otherwise authorize via policy and exec on host podman with the agent's cwd mapped
 * to its host path and stdin piped through. */
export function makeBrokerExecutor(policy: Policy, opts: BrokerOptions & { tonoman?: TonomanHandler } = {}): Executor {
  return async (argv: string[], cwd?: string, stdin?: string): Promise<ControlResponse> => {
    // Tonoman builtins (url/expose/unexpose) are resolved host-side, not by podman.
    // The agent can only *request* them; the broker decides + acts (default-deny on
    // missing wiring). The authorizedArgv carries only the builtin verb — never a secret.
    if (argv[0] === TONOMAN_BUILTIN) {
      const args = argv.slice(1);
      if (!opts.tonoman) {
        return { id: "", code: 127, stdout: "", stderr: "tonoman: builtin not available", error: "tonoman builtin not wired" };
      }
      const r = await opts.tonoman(args);
      return { id: "", code: r.code, stdout: r.stdout, stderr: r.stderr, authorizedArgv: [TONOMAN_BUILTIN, ...args] };
    }
    try {
      const hostCwd = cwd ? mapCwdToHost(policy, cwd) ?? undefined : undefined;
      const r = await brokerRun(policy, argv, { ...opts, cwd: hostCwd ?? opts.cwd, stdin });
      return {
        id: "",
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        authorizedArgv: r.authorizedArgv,
        error: r.timedOut ? "broker: command timed out" : undefined,
      };
    } catch (e) {
      if (e instanceof DenyError) {
        return { id: "", code: 126, stdout: "", stderr: e.message, denied: true, error: e.message };
      }
      const msg = (e as Error).message;
      return { id: "", code: 127, stdout: "", stderr: msg, error: msg };
    }
  };
}

/** Writes `obj` to `<file>` atomically (tmp + rename) so readers never see a partial file. */
async function writeAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Runs one poll pass over the requests directory: for each complete `*.json`
 * request, execute it and write the matching response, then remove the request.
 * Returns the number of requests processed. Pure I/O over `exec` — no podman here.
 */
export async function processRequests(
  reqDir: string,
  resDir: string,
  exec: Executor,
  ledger?: Ledger,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(reqDir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of entries) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const reqPath = path.join(reqDir, name);
    let req: ControlRequest;
    try {
      req = JSON.parse(await fs.readFile(reqPath, "utf8")) as ControlRequest;
    } catch {
      continue; // not yet fully written / not valid; try again next pass
    }
    await fs.rm(reqPath, { force: true });
    if (!req || !Array.isArray(req.argv)) continue;

    // Ledger: record the op as in-flight before running, so a turn that ends while
    // this op is still executing (the agent backgrounded it) can flag it as orphaned.
    await ledger?.opStart(req.id, req.argv, req.cwd);
    let res: ControlResponse;
    try {
      res = await exec(req.argv, req.cwd, req.stdin);
    } catch (e) {
      const msg = (e as Error).message;
      res = { id: req.id, code: 127, stdout: "", stderr: msg, error: msg };
    }
    res.id = req.id;
    // Terminal status. Logs only the authorized (pre-injection) argv — never secrets.
    await ledger?.opEnd(req.id, {
      code: res.code,
      denied: res.denied,
      reason: res.error,
      argv: res.authorizedArgv,
    });
    await writeAtomic(path.join(resDir, `${req.id}.json`), res);
    n++;
  }
  return n;
}

export interface ServeOptions {
  /** poll interval in ms; default 500. */
  intervalMs?: number;
  /** stop the loop when aborted. */
  signal?: AbortSignal;
  /** called once after the watch directories are ready (for logging). */
  onReady?: (reqDir: string) => void;
  /** records each brokered op's start + terminal status (A12 observability / the
   * orphan catch). Optional — omitted in tests that don't assert on the ledger. */
  ledger?: Ledger;
}

/**
 * Watches an agent's control directory and brokers each request until aborted.
 * Returns a promise that resolves when the signal aborts.
 */
export async function serveControl(dir: string, exec: Executor, opts: ServeOptions = {}): Promise<void> {
  const reqDir = path.join(dir, "requests");
  const resDir = path.join(dir, "responses");
  await fs.mkdir(reqDir, { recursive: true });
  await fs.mkdir(resDir, { recursive: true });
  opts.onReady?.(reqDir);

  const interval = opts.intervalMs ?? 500;
  while (!opts.signal?.aborted) {
    await processRequests(reqDir, resDir, exec, opts.ledger);
    await sleep(interval, opts.signal);
  }
}

/** A cancellable sleep that resolves immediately when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Client side (used by the in-container `podman`/`tonoman` shim): writes a request
 * and polls for its response. This is what runs *inside* the agent's sandbox.
 */
export async function controlRequest(
  dir: string,
  argv: string[],
  opts: { cwd?: string; stdin?: string; timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<ControlResponse> {
  const reqDir = path.join(dir, "requests");
  const resDir = path.join(dir, "responses");
  await fs.mkdir(reqDir, { recursive: true });
  await fs.mkdir(resDir, { recursive: true });

  const id = randomUUID();
  await writeAtomic(path.join(reqDir, `${id}.json`), { id, argv, cwd: opts.cwd, stdin: opts.stdin });

  const resPath = path.join(resDir, `${id}.json`);
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const poll = opts.pollMs ?? 200;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("controlRequest: aborted");
    try {
      const res = JSON.parse(await fs.readFile(resPath, "utf8")) as ControlResponse;
      await fs.rm(resPath, { force: true });
      return res;
    } catch {
      await sleep(poll, opts.signal);
    }
  }
  throw new Error(`controlRequest: timed out waiting for ${id}`);
}
