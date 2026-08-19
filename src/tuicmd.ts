// `tonoman tui <agent> [up|down|url|status]` — the host side of the web-TUI (tui-over-web).
// It just delegates to the baked in-container launcher (`tonoman-tui`), which starts ttyd
// + the mobile wrapper and asks the broker to LAN-forward the wrapper port via the same
// `tonoman expose` capability the agent could call itself. Thin on purpose: the launcher
// (image) owns the behavior so it stays identical whether triggered from the host CLI, the
// gateway, or the agent's own shell.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { buildTuiEnv, type TuiSub } from "./tui";
import type { Config } from "./config";

const SUBS: TuiSub[] = ["up", "down", "url", "status"];

export async function runTui(cfgPath: string, _env: string | undefined, args: string[]): Promise<void> {
  const [name, action = "up"] = args;
  if (!name || !SUBS.includes(action as TuiSub)) {
    process.stderr.write("usage: tonoman tui <agent> [up|down|url|status]\n");
    process.exit(2);
    return;
  }
  const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Config;
  const a = (cfg.agents ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  if (!a) throw new Error(`tui: no such agent "${name}" in ${cfgPath}`);
  if (!a.container) throw new Error(`tui: agent "${name}" has no container (a remote agent has no local TUI)`);
  if (action === "up" && !a.tui?.enabled) {
    throw new Error(
      `tui: agent "${name}" has no tui.enabled config — set tui.enabled and recreate the container so its wrapper port is published to host loopback.`,
    );
  }

  // Pass the agent's tui knobs as env to the launcher (it defaults them when unset).
  const eArgs = Object.entries(buildTuiEnv(a.tui)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const code = await new Promise<number>((resolve) => {
    const p = execFile("podman", ["exec", ...eArgs, a.container, "tonoman-tui", action], { maxBuffer: 1 << 24 }, (e, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      resolve(e ? ((e as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0);
    });
    p.on("error", (e) => {
      process.stderr.write(`tui: could not exec podman — ${e.message}\n`);
      resolve(1);
    });
  });
  process.exit(code);
}
