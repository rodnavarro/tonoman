import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RegistryControlPlane, controlPlaneFrom, FileControlPlane, type RegistryAgent } from "./controlplane";

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function putSecret(secret: string, key: string, value: string): Promise<void> {
  await fs.mkdir(path.join(dir, "secrets", secret), { recursive: true });
  await fs.writeFile(path.join(dir, "secrets", secret, key), value, "utf8");
}

function plane(agents: RegistryAgent[]): RegistryControlPlane {
  const fetchImpl = (async () =>
    ({ ok: true, json: async () => ({ agents }) }) as unknown as Response) as unknown as typeof fetch;
  return new RegistryControlPlane({
    baseUrl: "http://api.invalid",
    token: "t",
    secretsDir: path.join(dir, "secrets"),
    identityDir: path.join(dir, "identity"),
    stateRoot: dir,
    fetchImpl,
  });
}

const base: RegistryAgent = {
  guid: "g1",
  name: "nova",
  tenant: "acme",
  tenantId: "t1",
  channel: "slack",
  teamId: "T1",
  botTokenRef: "acme-slack:SLACK_BOT_TOKEN",
  appTokenRef: "acme-slack:SLACK_APP_TOKEN",
};

describe("RegistryControlPlane", () => {
  it("resolves token refs from mounted secrets — the token is never in the roster payload", async () => {
    await putSecret("acme-slack", "SLACK_BOT_TOKEN", "xoxb-real\n");
    await putSecret("acme-slack", "SLACK_APP_TOKEN", "xapp-real\n");
    const cfg = await plane([base]).roster();
    expect(cfg.agents).toHaveLength(1);
    // Trailing newline trimmed — kubernetes secret files routinely carry one, and Slack rejects it.
    expect(cfg.agents[0]!.slack).toMatchObject({ bot_token: "xoxb-real", app_token: "xapp-real" });
  });

  it("namespaces the agent by tenant, so two tenants may both name an agent the same", async () => {
    await putSecret("acme-slack", "SLACK_BOT_TOKEN", "b");
    await putSecret("acme-slack", "SLACK_APP_TOKEN", "a");
    const cfg = await plane([base]).roster();
    expect(cfg.agents[0]!.name).toBe("acme-nova");
    expect(cfg.agents[0]!.guid).toBe("g1");
  });

  it("skips ONE agent with an unresolvable credential rather than failing the whole roster", async () => {
    await putSecret("ok-slack", "SLACK_BOT_TOKEN", "b");
    await putSecret("ok-slack", "SLACK_APP_TOKEN", "a");
    const good: RegistryAgent = {
      ...base,
      guid: "g2",
      name: "scout",
      tenant: "globex",
      botTokenRef: "ok-slack:SLACK_BOT_TOKEN",
      appTokenRef: "ok-slack:SLACK_APP_TOKEN",
    };
    // `base` points at a secret that was never written.
    const cfg = await plane([base, good]).roster();
    expect(cfg.agents.map((a) => a.name)).toEqual(["globex-scout"]);
  });

  it("refuses a ref that tries to climb out of the secrets mount", async () => {
    await putSecret("acme-slack", "SLACK_APP_TOKEN", "a");
    const evil: RegistryAgent = { ...base, botTokenRef: "../../etc:passwd" };
    const cfg = await plane([evil]).roster();
    expect(cfg.agents).toHaveLength(0); // unresolvable → skipped, never read
  });

  it("writes identity to a file, because the harness takes a file and the registry holds text", async () => {
    await putSecret("acme-slack", "SLACK_BOT_TOKEN", "b");
    await putSecret("acme-slack", "SLACK_APP_TOKEN", "a");
    const cfg = await plane([{ ...base, identity: "# Nova\nYou are Nova." }]).roster();
    const file = cfg.agents[0]!.system_prompt_file!;
    expect(await fs.readFile(file, "utf8")).toContain("You are Nova.");
  });

  it("omits the identity file when the registry has no identity, rather than writing an empty one", async () => {
    await putSecret("acme-slack", "SLACK_BOT_TOKEN", "b");
    await putSecret("acme-slack", "SLACK_APP_TOKEN", "a");
    const cfg = await plane([{ ...base, identity: "   " }]).roster();
    expect(cfg.agents[0]!.system_prompt_file).toBeUndefined();
  });

  it("skips a channel it has no connector for, and keeps serving the rest", async () => {
    const cfg = await plane([{ ...base, channel: "teams" }]).roster();
    expect(cfg.agents).toHaveLength(0);
  });

  it("raises on a roster the API refuses — a gateway with no agents must not look healthy", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 401, text: async () => "unauthorized" }) as unknown as Response) as unknown as typeof fetch;
    const p = new RegistryControlPlane({ baseUrl: "http://api.invalid", token: "", fetchImpl });
    await expect(p.roster()).rejects.toThrow(/401/);
  });
});

describe("controlPlaneFrom", () => {
  it("keeps reading the file when Cloud is not configured, so no existing deployment changes", () => {
    expect(controlPlaneFrom({}, "/etc/tonoman/settings.json")).toBeInstanceOf(FileControlPlane);
  });

  it("uses the registry when TONOMANCLOUD_API_URL is set", () => {
    const p = controlPlaneFrom({ TONOMANCLOUD_API_URL: "http://api" }, "/unused");
    expect(p).toBeInstanceOf(RegistryControlPlane);
    expect(p.name()).toContain("http://api");
  });
});

describe("the roster mapping is a WHITELIST, and that cuts both ways", () => {
  // Every field the runtime uses is copied across by name here. That is the right shape — the
  // runtime takes only what it understands — but the cost is real and was paid once: `mission` was
  // added to the registry, to the roster response and to the voice flow, and dropped silently in
  // between. The recap came out with no Alignment section, which is indistinguishable from a model
  // that declined to judge. These assert the carriage itself.

  const withTokens = async () => {
    await putSecret("acme-slack", "SLACK_BOT_TOKEN", "b");
    await putSecret("acme-slack", "SLACK_APP_TOKEN", "a");
  };

  it("carries the tenant's mission through to the agent config", async () => {
    await withTokens();
    const cfg = await plane([{ ...base, mission: "Grow Axiplex to 20k/month. The constraint is my attention." }]).roster();
    expect(cfg.agents[0]!.mission).toBe("Grow Axiplex to 20k/month. The constraint is my attention.");
  });

  it("is an empty string, never undefined, for a tenant that has written none", async () => {
    await withTokens();
    // The voice flow tests this to decide whether to judge at all, and "" and undefined would be
    // two spellings of the same state for it to disagree about.
    const cfg = await plane([base]).roster();
    expect(cfg.agents[0]!.mission).toBe("");
  });

  it("carries flow settings through, which is how the voice flow is configured at all", async () => {
    await withTokens();
    const flows = { voice: { "route.axiplex-meetings": "Rod's own company", "transcribe.1.model": "whisper-1" } };
    const cfg = await plane([{ ...base, flows }]).roster();
    expect(cfg.agents[0]!.flows).toEqual(flows);
  });
});
