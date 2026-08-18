import { describe, it, expect } from "vitest";
import { extractTunnelUrl, messagingEndpoint, cloudflaredArgs, azRepointArgs, startTunnel, repointBot, type TunnelDeps } from "./tunnel";

// The URL extractor is the tricky pure bit: cloudflared prints its hostname inside a decorated
// ASCII banner, interleaved with timestamped log lines, so it must be recovered from noise.
describe("extractTunnelUrl", () => {
  it("recovers the hostname from cloudflared's banner", () => {
    const banner = `
2026-07-22T02:10:01Z INF Requesting new quick Tunnel on trycloudflare.com...
+--------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take a     |
|  moment to be reachable):                                           |
|  https://adaptive-penn-separate-sports.trycloudflare.com            |
+--------------------------------------------------------------------+
`;
    expect(extractTunnelUrl(banner)).toBe("https://adaptive-penn-separate-sports.trycloudflare.com");
  });

  it("returns undefined before the banner appears", () => {
    expect(extractTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeUndefined();
  });

  it("does not match the bare apex domain in the 'requesting' line", () => {
    // Guards a real failure mode: matching `trycloudflare.com` with no subdomain would yield a
    // dead endpoint that looks valid.
    expect(extractTunnelUrl("Requesting quick Tunnel on https://trycloudflare.com")).toBeUndefined();
  });
});

describe("messagingEndpoint", () => {
  it("appends the Bot Framework path", () => {
    expect(messagingEndpoint("https://x.trycloudflare.com")).toBe("https://x.trycloudflare.com/api/messages");
  });
  it("does not double the slash when the base has a trailing one", () => {
    expect(messagingEndpoint("https://x.trycloudflare.com/")).toBe("https://x.trycloudflare.com/api/messages");
  });
});

describe("argv assembly", () => {
  it("builds the cloudflared quick-tunnel argv", () => {
    expect(cloudflaredArgs(3979)).toEqual(["tunnel", "--url", "http://localhost:3979"]);
  });
  it("builds the az repoint argv", () => {
    expect(azRepointArgs("rg-cody", "cody-b47e5cbd", "https://x.trycloudflare.com")).toEqual([
      "bot", "update", "--resource-group", "rg-cody", "--name", "cody-b47e5cbd",
      "--endpoint", "https://x.trycloudflare.com/api/messages", "-o", "none",
    ]);
  });
});

describe("startTunnel", () => {
  const baseDeps = (): TunnelDeps => ({
    spawnTunnel: async (_b, _a, onOutput) => {
      onOutput("https://abc-def.trycloudflare.com");
      return 4242;
    },
    sleep: async () => {},
    now: () => new Date("2026-07-22T02:00:00Z"),
  });

  it("returns the pid + url", async () => {
    const st = await startTunnel({ enabled: true }, 3979, baseDeps());
    expect(st.pid).toBe(4242);
    expect(st.url).toBe("https://abc-def.trycloudflare.com");
  });

  it("does NOT repoint — that is the caller's step, so state can be persisted first", async () => {
    const calls: string[][] = [];
    const deps = { ...baseDeps(), repoint: async (_bin: string, args: string[]) => void calls.push(args) };
    await startTunnel({ enabled: true, azure: { resource_group: "rg", bot_name: "bot" } }, 3979, deps);
    expect(calls).toHaveLength(0); // otherwise a repoint failure would orphan the tunnel
  });

  it("throws when cloudflared never reports a URL (rather than leaving a useless tunnel)", async () => {
    const deps: TunnelDeps = {
      spawnTunnel: async () => 1,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => new Date((t += 20_000)); // blow past the deadline
      })(),
    };
    await expect(startTunnel({ enabled: true }, 3979, deps)).rejects.toThrow(/did not report a public URL/);
  });

  it("names the shim trap in the timeout error (the real-world cause)", async () => {
    const deps: TunnelDeps = {
      spawnTunnel: async () => 1,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => new Date((t += 20_000));
      })(),
    };
    await expect(startTunnel({ enabled: true, bin: "choco/bin/cloudflared.exe" }, 3979, deps)).rejects.toThrow(/shim/i);
  });
});

describe("repointBot", () => {
  const deps = (calls: string[][]): TunnelDeps => ({
    spawnTunnel: async () => 1,
    sleep: async () => {},
    now: () => new Date(),
    repoint: async (_bin: string, args: string[]) => void calls.push(args),
  });

  it("repoints the bot endpoint when azure coords are present", async () => {
    const calls: string[][] = [];
    const ok = await repointBot({ enabled: true, azure: { resource_group: "rg", bot_name: "bot" } }, "https://x.trycloudflare.com", deps(calls));
    expect(ok).toBe(true);
    expect(calls[0]).toContain("https://x.trycloudflare.com/api/messages");
  });

  it("reports false (and warns) when azure coords are absent — never silently no-ops", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const ok = await repointBot({ enabled: true }, "https://x.trycloudflare.com", deps(calls), (m) => logs.push(m));
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(logs.join(" ")).toMatch(/NOT repointed/);
  });
});
