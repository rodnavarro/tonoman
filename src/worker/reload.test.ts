import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { planReload } from "./reload.js";

/** A minimal servable agent, keyed (as the registry roster keys it) by its guid. */
function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "guid-1", // the stable key — a guid on a registry roster
    displayName: "sapien",
    tenant: "axiplex",
    container: "",
    harness: "claude-code",
    channel: "slack",
    model: "opus",
    max_turns: 20,
    slack: { app_token: "xapp-1", bot_token: "xoxb-1" },
    ...over,
  };
}

describe("planReload", () => {
  it("an unchanged roster produces an empty plan — a reload with no edits touches nothing", () => {
    const cfgs = [agent()];
    const plan = planReload(cfgs, [agent()]);
    expect(plan).toEqual({ added: [], removed: [], updated: [] });
  });

  // The regression that would flap Sapien's Slack socket on every rename. A rename changes only the
  // display name (the guid key is stable), so it must be a plain config swap — never a connector
  // rebuild, which reconnects the socket and drops messages.
  it("a rename (displayName only) is a plain mutate — the connector is NOT rebuilt", () => {
    const plan = planReload([agent()], [agent({ displayName: "sapien4" })]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.updated).toEqual([{ key: "guid-1", rebuildConn: false, rebuildRunner: false }]);
  });

  it("a new default model is a plain mutate — model is read per turn, no runner or connector rebuild", () => {
    const plan = planReload([agent()], [agent({ model: "sonnet" })]);
    expect(plan.updated).toEqual([{ key: "guid-1", rebuildConn: false, rebuildRunner: false }]);
  });

  it("a max_turns change rebuilds the runner but keeps the connector — it is baked in at construction", () => {
    const plan = planReload([agent()], [agent({ max_turns: 40 })]);
    expect(plan.updated).toEqual([{ key: "guid-1", rebuildConn: false, rebuildRunner: true }]);
  });

  it("a rotated Slack app token rebuilds the connector", () => {
    const plan = planReload([agent()], [agent({ slack: { app_token: "xapp-2", bot_token: "xoxb-1" } })]);
    expect(plan.updated).toEqual([{ key: "guid-1", rebuildConn: true, rebuildRunner: true }]);
  });

  it("a harness change rebuilds the connector (and thus the runner)", () => {
    const plan = planReload([agent()], [agent({ harness: "codex" })]);
    expect(plan.updated).toEqual([{ key: "guid-1", rebuildConn: true, rebuildRunner: true }]);
  });

  it("a changed allowed-users list rebuilds the connector", () => {
    const plan = planReload(
      [agent({ slack: { app_token: "xapp-1", bot_token: "xoxb-1", allowed_users: ["U1"] } })],
      [agent({ slack: { app_token: "xapp-1", bot_token: "xoxb-1", allowed_users: ["U1", "U2"] } })],
    );
    expect(plan.updated[0]).toEqual({ key: "guid-1", rebuildConn: true, rebuildRunner: true });
  });

  it("a new guid is added; a vanished guid is removed", () => {
    const a = agent({ name: "guid-1" });
    const b = agent({ name: "guid-2", displayName: "nelly", tenant: "murphy" });
    expect(planReload([a], [a, b]).added).toEqual(["guid-2"]);
    expect(planReload([a, b], [a]).removed).toEqual(["guid-2"]);
  });

  // A disabled agent, or one whose channel was turned off, simply drops out of the roster (the query
  // filters enabled + channel-bound), so disable is a `removed` and re-enable is an `added`. This
  // pins that the diff treats presence as the whole story — no separate "disabled" state to keep.
  it("disable reads as a removal, re-enable as an addition — presence is the whole story", () => {
    const a = agent();
    expect(planReload([a], []).removed).toEqual(["guid-1"]);
    expect(planReload([], [a]).added).toEqual(["guid-1"]);
  });

  it("classifies a mixed roster in one pass", () => {
    const keep = agent({ name: "g-keep" });
    const oldEdit = agent({ name: "g-edit", model: "opus" });
    const newEdit = agent({ name: "g-edit", model: "sonnet" });
    const gone = agent({ name: "g-gone" });
    const fresh = agent({ name: "g-fresh" });
    const plan = planReload([keep, oldEdit, gone], [keep, newEdit, fresh]);
    expect(plan.added).toEqual(["g-fresh"]);
    expect(plan.removed).toEqual(["g-gone"]);
    expect(plan.updated).toEqual([{ key: "g-edit", rebuildConn: false, rebuildRunner: false }]);
  });
});
