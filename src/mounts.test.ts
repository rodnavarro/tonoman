import { describe, it, expect } from "vitest";
import { findAgent, upsertMount, removeMount, listMounts, podmanVolumeArgs, agentMountPath } from "./mounts";
import type { Config, AgentConfig } from "./config";

const cfg = (...names: string[]): Config =>
  ({ health_addr: "", stream: { cursor: "", edit_interval_ms: 0 }, agents: names.map((n) => ({ name: n, container: n, telegram: { token: "t" } })) }) as Config;

describe("mounts — convention", () => {
  it("agentMountPath follows the ~/files/<name> convention (A9)", () => {
    expect(agentMountPath("acme")).toBe("/root/files/acme");
  });
});

describe("findAgent — resolve target agent (no guessing)", () => {
  it("uses the only agent when there is exactly one", () => {
    expect(findAgent(cfg("cody")).name).toBe("cody");
  });
  it("resolves by name (case-insensitive)", () => {
    expect(findAgent(cfg("cody", "scout"), "SCOUT").name).toBe("scout");
  });
  it("errors on multiple agents with no --agent", () => {
    expect(() => findAgent(cfg("cody", "scout"))).toThrow(/multiple agents/);
  });
  it("errors on an unknown agent name", () => {
    expect(() => findAgent(cfg("cody"), "nope")).toThrow(/no agent "nope"/);
  });
});

describe("upsert / remove / list mounts", () => {
  it("adds a new mount, then updates it in place by name", () => {
    const a: AgentConfig = { name: "cody", container: "cody", telegram: { token: "t" } };
    expect(upsertMount(a, { name: "acme", host: "C:/p/acme" })).toBe("added");
    expect(listMounts(a)).toHaveLength(1);
    expect(upsertMount(a, { name: "acme", host: "C:/p/acme2", read_only: true })).toBe("updated");
    expect(listMounts(a)).toHaveLength(1); // replaced, not duplicated
    expect(listMounts(a)[0]).toEqual({ name: "acme", host: "C:/p/acme2", read_only: true });
  });
  it("removes a mount by name; reports when nothing matched", () => {
    const a: AgentConfig = { name: "cody", container: "cody", telegram: { token: "t" }, mounts: [{ name: "acme", host: "h" }] };
    expect(removeMount(a, "acme")).toBe(true);
    expect(listMounts(a)).toHaveLength(0);
    expect(removeMount(a, "acme")).toBe(false);
  });

  it("mounts are PER-AGENT — adding to one agent does not touch another", () => {
    const c = cfg("cody", "scout");
    upsertMount(findAgent(c, "cody"), { name: "acme", host: "C:/p/acme" });
    expect(listMounts(findAgent(c, "cody"))).toHaveLength(1);
    expect(listMounts(findAgent(c, "scout"))).toHaveLength(0); // scout is unaffected — no global mount
  });
});

describe("podmanVolumeArgs — bring-up derives -v from config (no hardcoding)", () => {
  it("renders -v host:/root/files/<name>[:ro] per mount", () => {
    const a: AgentConfig = {
      name: "cody",
      container: "cody",
      telegram: { token: "t" },
      mounts: [
        { name: "acme", host: "C:/p/acme" },
        { name: "backups", host: "C:/p/backups", read_only: true },
      ],
    };
    expect(podmanVolumeArgs(a)).toEqual([
      "-v",
      "C:/p/acme:/root/files/acme",
      "-v",
      "C:/p/backups:/root/files/backups:ro",
    ]);
  });
  it("is empty for an agent with no mounts", () => {
    expect(podmanVolumeArgs({ name: "x", container: "x", telegram: { token: "t" } })).toEqual([]);
  });
  it("binds a mount with an explicit target at that path, not ~/files/<name> (cfg-mount-target)", () => {
    const a: AgentConfig = {
      name: "cody",
      container: "cody",
      telegram: { token: "t" },
      mounts: [{ name: "aws", host: "C:/p/acme/.aws", target: "/root/.aws", read_only: true }],
    };
    expect(podmanVolumeArgs(a)).toEqual(["-v", "C:/p/acme/.aws:/root/.aws:ro"]);
  });
});
