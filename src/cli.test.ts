import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCommand, parseGlobalFlags, defaultConfig, parseMountsArgs, envRoot, applyEnv, currentEnv } from "./cli";
import type { Config } from "./config";

// cli-grammar — kubectl-style VERB RESOURCE [name] grammar routes to one command.
describe("resolveCommand — grammar & dispatch (cli-grammar)", () => {
  it("routes the top-level commands", () => {
    expect(resolveCommand(["up"])).toEqual({ kind: "up" });
    expect(resolveCommand(["down"])).toEqual({ kind: "down" });
    expect(resolveCommand(["auth", "login", "cody"])).toEqual({ kind: "auth" });
  });

  it("routes logs (observability)", () => {
    expect(resolveCommand(["logs"])).toEqual({ kind: "logs" });
    expect(resolveCommand(["logs", "-a", "reacher", "-f"])).toEqual({ kind: "logs" });
  });

  it("routes get/create/delete to a normalized resource", () => {
    expect(resolveCommand(["get", "agents"])).toEqual({ kind: "get", resource: "agents" });
    expect(resolveCommand(["get", "services", "extra"])).toEqual({ kind: "get", resource: "services" });
    expect(resolveCommand(["create", "mount", "x", "/h"])).toEqual({ kind: "create", resource: "mounts" });
    expect(resolveCommand(["delete", "mount", "x"])).toEqual({ kind: "delete", resource: "mounts" });
  });

  it("routes set/get for the memory resource (cfg-memory-cli)", () => {
    expect(resolveCommand(["set", "memory", "git"])).toEqual({ kind: "set", resource: "memory" });
    expect(resolveCommand(["get", "memory"])).toEqual({ kind: "get", resource: "memory" });
    expect((resolveCommand(["get", "mem"]) as { resource: string }).resource).toBe("memory");
  });

  it("routes browser verbs: create/get/delete + open/close (browser-cli)", () => {
    expect(resolveCommand(["create", "browser", "-a", "reacher"])).toEqual({ kind: "create", resource: "browsers" });
    expect(resolveCommand(["get", "browsers"])).toEqual({ kind: "get", resource: "browsers" });
    expect(resolveCommand(["delete", "browser", "-a", "reacher"])).toEqual({ kind: "delete", resource: "browsers" });
    expect(resolveCommand(["open", "browser", "-a", "reacher"])).toEqual({ kind: "open", resource: "browsers" });
    expect(resolveCommand(["close", "browser", "-a", "reacher"])).toEqual({ kind: "close", resource: "browsers" });
  });

  it("open/close only support the browser resource → usage exit 2 otherwise", () => {
    expect(resolveCommand(["open", "agents"])).toMatchObject({ kind: "usage", exitCode: 2 });
    expect(resolveCommand(["close", "mounts"])).toMatchObject({ kind: "usage", exitCode: 2 });
  });

  it("accepts singular / plural / short resource aliases (po/pods)", () => {
    expect(resolveCommand(["get", "agent"]).kind === "get" && (resolveCommand(["get", "agent"]) as any).resource).toBe("agents");
    expect((resolveCommand(["get", "mount"]) as any).resource).toBe("mounts");
    expect((resolveCommand(["get", "svc"]) as any).resource).toBe("services");
    expect((resolveCommand(["get", "service"]) as any).resource).toBe("services");
  });
});

// cli-dispatch-errors — a malformed invocation fails loud (exit 2), never silently.
describe("resolveCommand — errors (cli-dispatch-errors)", () => {
  it("no command at all → usage, exit 2, no error line", () => {
    expect(resolveCommand([])).toEqual({ kind: "usage", exitCode: 2 });
  });
  it("unknown command → usage, exit 2, names the typo", () => {
    const r = resolveCommand(["frobnicate"]);
    expect(r).toMatchObject({ kind: "usage", exitCode: 2 });
    expect((r as any).error).toContain("frobnicate");
  });
  it("unknown resource → usage, exit 2, names the bad resource", () => {
    const r = resolveCommand(["get", "widgets"]);
    expect(r).toMatchObject({ kind: "usage", exitCode: 2 });
    expect((r as any).error).toContain("widgets");
  });
  it("missing resource after a verb → usage, exit 2", () => {
    expect(resolveCommand(["get"])).toMatchObject({ kind: "usage", exitCode: 2 });
  });
});

// cli-version-help — version & help always reachable, by every common alias.
describe("resolveCommand — version & help (cli-version-help)", () => {
  it("version via all aliases", () => {
    for (const a of ["version", "--version", "-v"]) expect(resolveCommand([a])).toEqual({ kind: "version" });
  });
  it("help via all aliases", () => {
    for (const a of ["help", "--help", "-h"]) expect(resolveCommand([a])).toEqual({ kind: "help" });
  });
});

// cli-config-resolution — one precedence everywhere; every --config form; rest preserved.
describe("config resolution (cli-config-resolution)", () => {
  const savedCfg = process.env.TONOMAN_CONFIG;
  const savedEnv = process.env.TONOMAN_ENV;
  beforeEach(() => { delete process.env.TONOMAN_CONFIG; delete process.env.TONOMAN_ENV; });
  afterEach(() => {
    if (savedCfg === undefined) delete process.env.TONOMAN_CONFIG; else process.env.TONOMAN_CONFIG = savedCfg;
    if (savedEnv === undefined) delete process.env.TONOMAN_ENV; else process.env.TONOMAN_ENV = savedEnv;
  });

  it("defaultConfig: $TONOMAN_CONFIG wins over the home roster (default env)", () => {
    process.env.TONOMAN_CONFIG = "/custom/here.json";
    expect(defaultConfig()).toBe("/custom/here.json");
  });
  it("defaultConfig: falls back to ~/.tonoman/settings.json", () => {
    expect(defaultConfig()).toBe(path.join(os.homedir(), ".tonoman", "settings.json"));
  });

  it("an explicit --config flag wins, in every form, and leaves rest untouched", () => {
    expect(parseGlobalFlags(["--config", "a.json", "get", "agents"])).toEqual({ cfgPath: "a.json", rest: ["get", "agents"] });
    expect(parseGlobalFlags(["-config", "b.json"])).toMatchObject({ cfgPath: "b.json" });
    expect(parseGlobalFlags(["--config=c.json", "get"])).toEqual({ cfgPath: "c.json", rest: ["get"] });
    expect(parseGlobalFlags(["-config=d.json"])).toMatchObject({ cfgPath: "d.json" });
  });

  it("--config is found anywhere in argv (before or after the verb) and stripped", () => {
    expect(parseGlobalFlags(["get", "mounts", "-a", "cody", "--config", "x.json"])).toEqual({
      cfgPath: "x.json",
      rest: ["get", "mounts", "-a", "cody"], // -a is NOT global; left for the command
    });
  });

  it("no flag → the default path, rest unchanged", () => {
    process.env.TONOMAN_CONFIG = "/env.json";
    expect(parseGlobalFlags(["get", "agents"])).toEqual({ cfgPath: "/env.json", rest: ["get", "agents"] });
  });
});

// cli-env — `TONOMAN_ENV` selects an isolated environment (root + container suffix).
describe("named environments (cli-env)", () => {
  const savedCfg = process.env.TONOMAN_CONFIG;
  const savedEnv = process.env.TONOMAN_ENV;
  beforeEach(() => { delete process.env.TONOMAN_CONFIG; delete process.env.TONOMAN_ENV; });
  afterEach(() => {
    if (savedCfg === undefined) delete process.env.TONOMAN_CONFIG; else process.env.TONOMAN_CONFIG = savedCfg;
    if (savedEnv === undefined) delete process.env.TONOMAN_ENV; else process.env.TONOMAN_ENV = savedEnv;
  });

  it("currentEnv: reads TONOMAN_ENV, treating unset/blank as the default env", () => {
    expect(currentEnv()).toBeUndefined();
    process.env.TONOMAN_ENV = "   ";
    expect(currentEnv()).toBeUndefined();
    process.env.TONOMAN_ENV = "dev";
    expect(currentEnv()).toBe("dev");
  });

  it("envRoot: ~/.tonoman by default, ~/.tonoman-<name> for a named env", () => {
    expect(envRoot()).toBe(path.join(os.homedir(), ".tonoman"));
    expect(envRoot("dev")).toBe(path.join(os.homedir(), ".tonoman-dev"));
  });

  it("TONOMAN_ENV routes config to the env root and outranks $TONOMAN_CONFIG (named env owns its config)", () => {
    process.env.TONOMAN_CONFIG = "/env.json";
    process.env.TONOMAN_ENV = "dev";
    expect(defaultConfig()).toBe(path.join(os.homedir(), ".tonoman-dev", "settings.json"));
    expect(defaultConfig("staging")).toBe(path.join(os.homedir(), ".tonoman-staging", "settings.json")); // explicit arg
  });

  it("applyEnv suffixes every container with -<env> (dev can never target prod's cody)", () => {
    const cfg = { agents: [{ name: "cody", container: "cody" }, { name: "scout", container: "scout" }] } as Config;
    applyEnv(cfg, "dev");
    expect(cfg.agents.map((a) => a.container)).toEqual(["cody-dev", "scout-dev"]);
    expect(cfg.state_root).toBe(envRoot("dev"));
  });

  it("the default env is a no-op — containers unsuffixed (today's behavior)", () => {
    const cfg = { agents: [{ name: "cody", container: "cody" }] } as Config;
    applyEnv(cfg, undefined);
    expect(cfg.agents[0].container).toBe("cody"); // unchanged
  });
});

// cli-mounts-args / cli-agent-scope — flags parse regardless of position; positionals survive.
describe("parseMountsArgs — flags vs positionals (cli-mounts-args)", () => {
  it("extracts -a/--agent, --ro/--read-only, --podman", () => {
    expect(parseMountsArgs(["-a", "cody", "--podman"])).toEqual({ agent: "cody", ro: false, podman: true, pos: [] });
    expect(parseMountsArgs(["--agent", "scout", "--read-only"])).toEqual({ agent: "scout", ro: true, podman: false, pos: [] });
  });

  it("positionals survive in order regardless of flag position", () => {
    const a = parseMountsArgs(["acme", "C:/p/acme", "--ro", "-a", "cody"]);
    const b = parseMountsArgs(["--ro", "acme", "-a", "cody", "C:/p/acme"]);
    expect(a.pos).toEqual(["acme", "C:/p/acme"]);
    expect(b.pos).toEqual(["acme", "C:/p/acme"]);
    expect(a).toEqual(b); // equivalent invocations
  });

  it("no flags → empty defaults", () => {
    expect(parseMountsArgs([])).toEqual({ agent: undefined, ro: false, podman: false, pos: [] });
  });
});

describe("resolveCommand — backend switch (backend-switch-live)", () => {
  it("parses agent + mode", () => {
    expect(resolveCommand(["backend", "atlas", "bedrock"])).toEqual({ kind: "backend", agent: "atlas", mode: "bedrock" });
  });
  it("parses agent with no mode (report current)", () => {
    expect(resolveCommand(["backend", "atlas"])).toEqual({ kind: "backend", agent: "atlas", mode: undefined });
  });
  it("missing agent → usage error", () => {
    expect(resolveCommand(["backend"])).toMatchObject({ kind: "usage", exitCode: 2 });
  });
});
