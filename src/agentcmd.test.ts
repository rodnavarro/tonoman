import { describe, it, expect } from "vitest";
import { parseCreateAgentArgs, parseMountSpec } from "./agentcmd";

// roster-provision — `create agent` parses its flags/positionals (the pure seam; the
// scaffold + podman run are smoke-verified under TONOMAN_ENV=smoke).
describe("parseCreateAgentArgs (roster-provision)", () => {
  it("takes the name positionally and defaults harness to claude-code, no auth path", () => {
    const o = parseCreateAgentArgs(["cardy"]);
    expect(o.name).toBe("cardy");
    expect(o.harness).toBe("claude-code");
    expect(o.login).toBe(false);
    expect(o.from).toBeUndefined();
    expect(o.mounts).toEqual([]);
  });

  it("parses the auth paths and metadata flags regardless of order", () => {
    const o = parseCreateAgentArgs(["--role", "registrar", "cardy", "--from", "cody", "--model", "sonnet"]);
    expect(o).toMatchObject({ name: "cardy", role: "registrar", from: "cody", model: "sonnet" });
  });

  it("collects repeatable --mount specs", () => {
    const o = parseCreateAgentArgs(["cardy", "--mount", "cards=C:/files/cards", "--mount", "ref=/srv/ref:ro"]);
    expect(o.mounts).toEqual([
      { name: "cards", host: "C:/files/cards", read_only: undefined },
      { name: "ref", host: "/srv/ref", read_only: true },
    ]);
  });

  it("--login and --image are honored", () => {
    const o = parseCreateAgentArgs(["cardy", "--login", "--image", "localhost/tonoman/claudecode:latest"]);
    expect(o.login).toBe(true);
    expect(o.image).toBe("localhost/tonoman/claudecode:latest");
  });

  it("collects repeatable --skill dirs (a roster registers its own content here)", () => {
    const o = parseCreateAgentArgs(["cardy", "--skill", "/c/agentic-org/skills/example-org/register-business-card", "--skill", "./skills/collect"]);
    expect(o.skills).toEqual(["/c/agentic-org/skills/example-org/register-business-card", "./skills/collect"]);
  });

  it("collects --ssh-key and repeatable --setup steps (cfg-ssh-key / cfg-agent-tools)", () => {
    const o = parseCreateAgentArgs(["cardy", "--ssh-key", "C:/Users/u/.ssh/id", "--setup", "apt-get install -y awscli", "--setup", "dotnet --version"]);
    expect(o.sshKey).toBe("C:/Users/u/.ssh/id");
    expect(o.setup).toEqual(["apt-get install -y awscli", "dotnet --version"]);
  });

  it("parses Teams channel wiring (teams-config): --channel teams + --teams-* flags", () => {
    const o = parseCreateAgentArgs([
      "billy-cc", "--harness", "claude-code", "--channel", "teams",
      "--teams-app-id", "app-123", "--teams-tenant", "tn-1", "--teams-allowed-user", "aad-rod", "--teams-port", "3979",
    ]);
    expect(o.channel).toBe("teams");
    expect(o.teamsAppId).toBe("app-123");
    expect(o.teamsTenant).toBe("tn-1");
    expect(o.teamsAllowedUser).toBe("aad-rod");
    expect(o.teamsPort).toBe(3979);
  });
});

describe("parseMountSpec (roster-provision)", () => {
  it("splits name=host, preserving a Windows drive colon and stripping a trailing :ro", () => {
    expect(parseMountSpec("cards=C:/files/cards")).toEqual({ name: "cards", host: "C:/files/cards", read_only: undefined });
    expect(parseMountSpec("cards=C:/files/cards:ro")).toEqual({ name: "cards", host: "C:/files/cards", read_only: true });
  });
  it("rejects a spec with no = or an empty side", () => {
    expect(parseMountSpec("nope")).toBeUndefined();
    expect(parseMountSpec("=/h")).toBeUndefined();
    expect(parseMountSpec("name=")).toBeUndefined();
    expect(parseMountSpec(undefined)).toBeUndefined();
  });
});
