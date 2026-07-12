// Config validation for the channel discriminator (teams-config): a Teams agent needs
// teams.app_id + teams.tenant_id (app_password is an injected secret, not required in the
// roster); a Telegram agent still needs telegram.token (unchanged). Free unit, no IO.

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validate, load, type Config, type AgentConfig } from "./config";

function cfg(agent: Partial<AgentConfig>): Config {
  return {
    state_root: "/state",
    health_addr: "127.0.0.1:9100",
    stream: { cursor: "▌", edit_interval_ms: 500 },
    agents: [{ name: "a", container: "tn-a", ...agent } as AgentConfig],
  };
}

describe("load — org config_repo seam (learn-durable / learn-registry-from-config)", () => {
  it("surfaces config_repo when set, and leaves it undefined when absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tncfg-"));
    const withRepo = path.join(dir, "a.json");
    await fs.writeFile(withRepo, JSON.stringify({ health_addr: "127.0.0.1:1", agents: [], config_repo: "github.com/example-org/tonoman-config" }));
    const withoutRepo = path.join(dir, "b.json");
    await fs.writeFile(withoutRepo, JSON.stringify({ health_addr: "127.0.0.1:1", agents: [] }));
    expect((await load(withRepo)).config_repo).toBe("github.com/example-org/tonoman-config");
    expect((await load(withoutRepo)).config_repo).toBeUndefined(); // personal-only org
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("validate — channel credentials (teams-config)", () => {
  it("accepts a Teams agent with app_id + tenant_id (app_password injected at run time)", () => {
    expect(() => validate(cfg({ channel: "teams", teams: { app_id: "app", tenant_id: "tn" } }))).not.toThrow();
  });

  it("infers Teams from a `teams` block with no explicit channel", () => {
    expect(() => validate(cfg({ teams: { app_id: "app", tenant_id: "tn" } }))).not.toThrow();
  });

  it("rejects a Teams agent missing tenant_id", () => {
    expect(() => validate(cfg({ channel: "teams", teams: { app_id: "app" } as never }))).toThrow(/teams\.tenant_id/);
  });

  it("rejects a Teams agent missing app_id", () => {
    expect(() => validate(cfg({ teams: { tenant_id: "tn" } as never }))).toThrow(/teams\.app_id/);
  });

  it("still requires telegram.token for a Telegram agent (unchanged)", () => {
    expect(() => validate(cfg({ telegram: { token: "t" } }))).not.toThrow();
    expect(() => validate(cfg({}))).toThrow(/telegram\.token/);
  });

  it("a service agent needs no connector creds (owns its own channel)", () => {
    expect(() => validate(cfg({ service: true }))).not.toThrow();
  });
});

describe("validate — remote agent (claude-code-http, k8s split)", () => {
  const remote = (over: Partial<AgentConfig>): Config => ({
    state_root: "/state",
    health_addr: "127.0.0.1:9100",
    stream: { cursor: "▌", edit_interval_ms: 500 },
    agents: [{ name: "atlas", harness: "claude-code-http", teams: { app_id: "app", tenant_id: "tn" }, ...over } as AgentConfig],
  });

  it("accepts a remote agent with url and NO local container", () => {
    expect(() => validate(remote({ url: "http://atlas-agent:8080" }))).not.toThrow();
  });

  it("requires url for a remote agent", () => {
    expect(() => validate(remote({}))).toThrow(/url/);
  });

  it("a local (podman) agent still requires container", () => {
    const local = cfg({ harness: "claude-code", container: "", telegram: { token: "t" } });
    expect(() => validate(local)).toThrow(/container/);
  });
});

describe("validate — auth backend (backend-config-default)", () => {
  it("auth: bedrock REQUIRES a region", () => {
    expect(() => validate(cfg({ telegram: { token: "t" }, auth: "bedrock" }))).toThrow(/region/);
  });
  it("auth: bedrock with a region is accepted", () => {
    expect(() => validate(cfg({ telegram: { token: "t" }, auth: "bedrock", region: "us-east-1" }))).not.toThrow();
  });
  it("auth: subscription needs no region", () => {
    expect(() => validate(cfg({ telegram: { token: "t" }, auth: "subscription" }))).not.toThrow();
  });
  it("rejects an unknown auth value", () => {
    expect(() => validate(cfg({ telegram: { token: "t" }, auth: "openai" as never }))).toThrow(/invalid auth/);
  });
});
