import { describe, it, expect } from "vitest";
import { tuiPort, buildTuiEnv, DEFAULT_TUI_PORT } from "./tui";
import { podmanRunArgs } from "./provision";
import type { AgentConfig, Config } from "./config";
import type { Spec } from "./harness";

describe("tui pure logic", () => {
  it("defaults the wrapper port when unset", () => {
    expect(tuiPort(undefined)).toBe(DEFAULT_TUI_PORT);
    expect(tuiPort({ enabled: true })).toBe(DEFAULT_TUI_PORT);
    expect(tuiPort({ enabled: true, port: 9000 })).toBe(9000);
  });

  it("emits env only for set knobs (launcher defaults the rest)", () => {
    expect(buildTuiEnv(undefined)).toEqual({});
    expect(buildTuiEnv({ enabled: true })).toEqual({});
    expect(buildTuiEnv({ enabled: true, port: 9000, ttyd_port: 9001, font: 18 })).toEqual({
      TUI_PORT: "9000",
      TTYD_PORT: "9001",
      TUI_FONT: "18",
    });
  });
});

describe("provision publishes the tui port (loopback, opt-in)", () => {
  const spec = {
    kind: "claude-code",
    image: "localhost/tonoman/claudecode:latest",
    configHome: "/root/.claude",
    identityHome: "/root/agent",
    runEnv: { CLAUDE_CONFIG_DIR: "/root/.claude" },
  } as unknown as Spec;
  const cfg = { state_root: "/srv/tonoman", agents: [], stream: { cursor: "", edit_interval_ms: 0 }, health_addr: "x" } as Config;
  const base = { name: "dev", container: "dev", guid: "g-1" } as AgentConfig;

  it("does NOT publish anything when tui is absent/disabled", () => {
    expect(podmanRunArgs(base, cfg, spec).join(" ")).not.toContain("7682");
    expect(podmanRunArgs({ ...base, tui: { enabled: false } }, cfg, spec).join(" ")).not.toContain("7682");
  });

  it("publishes the wrapper port to host loopback when tui.enabled", () => {
    const args = podmanRunArgs({ ...base, tui: { enabled: true } }, cfg, spec);
    const i = args.indexOf("-p");
    expect(args).toContain("127.0.0.1:7682:7682");
    expect(i).toBeGreaterThan(-1);
  });

  it("honors a custom tui port", () => {
    const args = podmanRunArgs({ ...base, tui: { enabled: true, port: 9000 } }, cfg, spec);
    expect(args.join(" ")).toContain("127.0.0.1:9000:9000");
  });
});
