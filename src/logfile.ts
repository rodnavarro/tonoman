// Persistent gateway log (observability — so we can actually debug the iterate loop).
// Tees console.log/warn/error to a timestamped append-file IN ADDITION to the real
// stdout/stderr, so the gateway's turn / broker / error log survives the process and is
// inspectable (`tonoman logs`, or Read) no matter who ran `tonoman up`. Best-effort: a log
// write can never crash the gateway.

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import * as path from "node:path";

let stream: WriteStream | undefined;

/** Default gateway log path for an env's state root. */
export function gatewayLogPath(stateRoot: string): string {
  return path.join(stateRoot, "gateway.log");
}

/** Begin teeing console output to `file` (append). Idempotent — only the first call wires it. */
export function teeConsole(file: string): void {
  if (stream) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    stream = createWriteStream(file, { flags: "a" });
  } catch {
    return; // can't open the log file → just keep console as-is (never fatal)
  }
  const wrap =
    (orig: (...a: unknown[]) => void, level: string) =>
    (...args: unknown[]): void => {
      try {
        const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        stream!.write(`${new Date().toISOString()} ${level} ${line}\n`);
      } catch {
        /* best-effort: never let logging throw */
      }
      orig(...args);
    };
  console.log = wrap(console.log.bind(console) as (...a: unknown[]) => void, "INFO");
  console.warn = wrap(console.warn.bind(console) as (...a: unknown[]) => void, "WARN");
  console.error = wrap(console.error.bind(console) as (...a: unknown[]) => void, "ERROR");
}
