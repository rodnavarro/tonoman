// Where a Talent's channel setting leads (docs/definition/objects/drop-watch.md in Tonoman Cloud).
import { describe, it, expect } from "vitest";
import { channelIdOf, channelRef, channelResolver, type SlackCall } from "./channelsay";

const slack = (pages: { id: string; name: string }[][]) => {
  const calls: Record<string, unknown>[] = [];
  const call = (async (method: string, body: Record<string, unknown> = {}) => {
    calls.push({ method, ...body });
    const i = body.cursor ? Number(body.cursor) : 0;
    return { ok: true, channels: pages[i] ?? [], response_metadata: { next_cursor: i + 1 < pages.length ? String(i + 1) : "" } };
  }) as SlackCall;
  return { call, calls };
};

describe("the channel a Talent's settings name", () => {
  it("DROPS-IN-A-CHANNEL a channel may be given by its id or by its name, with or without the #", () => {
    expect(channelRef("C0C2DPQB7PY")).toEqual({ id: "C0C2DPQB7PY" });
    expect(channelRef(" #Drops ")).toEqual({ name: "drops" });
    expect(channelRef("drops")).toEqual({ name: "drops" });
    expect(channelRef("  ")).toBeUndefined();
    // A person is never a channel: this is what sent every drop nowhere.
    expect(channelRef("U0AAAAAAA2")).toEqual({ name: "u0aaaaaaa2" });
  });

  it("DROPS-IN-A-CHANNEL an id is used as it is, without asking Slack anything", async () => {
    const s = slack([[]]);
    expect(await channelIdOf(s.call, "C0C2DPQB7PY")).toBe("C0C2DPQB7PY");
    expect(s.calls).toEqual([]);
  });

  it("DROPS-IN-A-CHANNEL a name is found among the channels the agent can see, public or private, on whichever page it is", async () => {
    const s = slack([[{ id: "C1", name: "general" }], [{ id: "C2", name: "drops" }]]);
    expect(await channelIdOf(s.call, "#drops")).toBe("C2");
    expect(s.calls[0]).toMatchObject({ method: "conversations.list", types: "public_channel,private_channel", exclude_archived: true });
    expect(s.calls.length).toBe(2);
  });

  it("DROPS-IN-A-CHANNEL a name nobody has is no channel — and is looked for again next time, not remembered as missing", async () => {
    const pages: { id: string; name: string }[][] = [[{ id: "C1", name: "general" }]];
    const s = slack(pages);
    const resolve = channelResolver();
    expect(await resolve("mia", s.call, "#drops")).toBeUndefined();
    pages[0]!.push({ id: "C9", name: "drops" }); // made a minute later
    expect(await resolve("mia", s.call, "#drops")).toBe("C9");
    const before = s.calls.length;
    expect(await resolve("mia", s.call, "#DROPS")).toBe("C9"); // kept: no third listing
    expect(s.calls.length).toBe(before);
  });
});
