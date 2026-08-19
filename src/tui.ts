// Web-TUI (tui-over-web) pure logic — the defaults + env mapping shared by the host CLI
// (tuicmd) and provisioning, so the wrapper/ttyd ports never drift between "what gets
// published" and "what the launcher serves". No side effects; unit-tested.

import type { Tui } from "./config";

/** LAN-facing wrapper port (published to host loopback + `tonoman expose`d). */
export const DEFAULT_TUI_PORT = 7682;
/** loopback-only ttyd port inside the sandbox, behind the wrapper. */
export const DEFAULT_TTYD_PORT = 7681;
/** mobile-friendly xterm font size. */
export const DEFAULT_TUI_FONT = 15;

export type TuiSub = "up" | "down" | "url" | "status";

/** The wrapper port to publish/expose for an agent (the one thing provisioning needs). */
export function tuiPort(tui: Tui | undefined): number {
  return tui?.port ?? DEFAULT_TUI_PORT;
}

/** The env passed to the in-container `tonoman-tui` launcher. Only set knobs are emitted;
 * the launcher applies the same defaults for anything omitted. */
export function buildTuiEnv(tui: Tui | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (tui?.port != null) env.TUI_PORT = String(tui.port);
  if (tui?.ttyd_port != null) env.TTYD_PORT = String(tui.ttyd_port);
  if (tui?.font != null) env.TUI_FONT = String(tui.font);
  return env;
}
