// Where an answer that used a brain may go. Titles start with the rule they prove.
import { describe, it, expect } from "vitest";
import { audienceOf, decideRoute, privateReason, type Audience } from "./delivery";
import { repoName, plainRemote } from "./ado";

const slack = (info: unknown, pages: unknown[] = [], fail?: string) => {
  let i = 0;
  const calls: { method: string; body?: Record<string, unknown> }[] = [];
  const call = async <T,>(method: string, body?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, body });
    if (fail && method === fail) throw new Error("slack: missing_scope");
    if (method === "conversations.info") return info as T;
    return pages[i++] as T;
  };
  return { call, calls };
};

describe("who will see it", () => {
  it("BRAIN-AUDIENCE the speaker's own DM is the speaker alone", async () => {
    expect(await audienceOf(slack({ channel: { is_im: true, user: "UANA" } }).call, "D1", "UANA", "UBOT")).toEqual({ kind: "self" });
  });

  it("BRAIN-AUDIENCE a public channel counts as the whole workspace", async () => {
    expect(await audienceOf(slack({ channel: { is_channel: true, name: "general" } }).call, "C1", "UANA", "UBOT")).toEqual({ kind: "public", name: "general" });
  });

  it("BRAIN-AUDIENCE a private channel is counted in full, every page, leaving the agent itself out", async () => {
    const s = slack({ channel: { is_private: true, name: "eng" } }, [
      { members: ["UANA", "UBOT"], response_metadata: { next_cursor: "c2" } },
      { members: ["UBEN"], response_metadata: { next_cursor: "" } },
    ]);
    expect(await audienceOf(s.call, "G1", "UANA", "UBOT")).toEqual({ kind: "members", members: ["UANA", "UBEN"], name: "eng" });
    expect(s.calls.filter((c) => c.method === "conversations.members").map((c) => c.body?.cursor)).toEqual([undefined, "c2"]);
  });

  it("BRAIN-AUDIENCE a group DM is counted like a private channel", async () => {
    const s = slack({ channel: { is_mpim: true } }, [{ members: ["UANA", "UBEN", "UBOT"] }]);
    expect(await audienceOf(s.call, "G2", "UANA", "UBOT")).toEqual({ kind: "members", members: ["UANA", "UBEN"], name: undefined });
  });

  it("BRAIN-AUDIENCE when Slack will not say who is there, the audience cannot read any brain", async () => {
    expect((await audienceOf(slack({ channel: { is_private: true } }, [], "conversations.members").call, "G1", "UANA", "UBOT")).kind).toBe("unknown");
    expect((await audienceOf(slack({}, [], "conversations.info").call, "G1", "UANA", "UBOT")).kind).toBe("unknown");
  });

  it("BRAIN-AUDIENCE a channel shared with another workspace cannot be counted", async () => {
    for (const flag of ["is_ext_shared", "is_shared", "is_org_shared"]) {
      const s = slack({ channel: { is_private: true, [flag]: true } }, [{ members: ["UANA"] }]);
      expect((await audienceOf(s.call, "G1", "UANA", "UBOT")).kind).toBe("unknown");
    }
  });

  it("BRAIN-AUDIENCE a member list that leaves out the person asking is not trusted", async () => {
    const s = slack({ channel: { is_private: true } }, [{ members: ["UBEN"] }]);
    expect((await audienceOf(s.call, "G1", "UANA", "UBOT")).kind).toBe("unknown");
    expect((await audienceOf(slack({ channel: { is_private: true } }, [{}]).call, "G1", "UANA", "UBOT")).kind).toBe("unknown");
  });

  it("BRAIN-AUDIENCE another person's DM is never treated as the speaker's", async () => {
    expect((await audienceOf(slack({ channel: { is_im: true, user: "UBEN" } }).call, "D2", "UANA", "UBOT")).kind).toBe("unknown");
  });
});

describe("where it goes", () => {
  const members: Audience = { kind: "members", members: ["UANA", "UBEN"], name: "eng" };

  it("BRAIN-PRIVATE-DELIVERY an answer that used no brain goes in the thread", () => {
    expect(decideRoute({ kind: "public" }, [], null)).toEqual({ to: "thread" });
  });

  it("BRAIN-PRIVATE-DELIVERY in the speaker's own DM it always goes in the thread", () => {
    expect(decideRoute({ kind: "self" }, ["b-ana"], null)).toEqual({ to: "thread" });
  });

  it("BRAIN-PRIVATE-DELIVERY a brain some member cannot read sends it privately", () => {
    expect(decideRoute(members, ["b-ana", "b-eng"], ["b-eng"])).toEqual({ to: "private" });
  });

  it("BRAIN-PRIVATE-DELIVERY brains every member can read keep it in the thread", () => {
    expect(decideRoute(members, ["b-eng"], ["b-eng", "b-other"])).toEqual({ to: "thread" });
  });

  it("BRAIN-PRIVATE-DELIVERY a public channel or an uncounted audience always sends it privately", () => {
    expect(decideRoute({ kind: "public" }, ["b-eng"], ["b-eng"])).toEqual({ to: "private" });
    expect(decideRoute({ kind: "unknown", why: "x" }, ["b-eng"], ["b-eng"])).toEqual({ to: "private" });
  });

  it("BRAIN-PRIVATE-DELIVERY the DM opens by saying why it arrived there", () => {
    expect(privateReason(["Ana's brain"], members)).toBe("_Answering here because part of this comes from Ana's brain, and not everyone in #eng can read it._");
    expect(privateReason(["Ana's brain", "Engineering"], { kind: "public", name: "general" })).toBe(
      "_Answering here because part of this comes from Ana's brain and Engineering, and #general is public, so anyone in the workspace could read it there._",
    );
  });
});

describe("the repo's name", () => {
  it("BRAIN-REPO-ON-FIRST-USE a repo is named for the tenant, the brain and its id, with the environment's suffix", () => {
    expect(repoName("axiplex", "rod-3f9a1c", "dev", "0a1b2c3d-4e5f-6789-abcd-ef0123456789")).toBe("brain-axiplex-rod-3f9a1c-0a1b2c3d4e5f-dev");
    expect(repoName("Test A", "Eng Notes!", "", "0a1b2c3d-4e5f-6789-abcd-ef0123456789")).toBe("brain-test-a-eng-notes-0a1b2c3d4e5f");
  });

  it("BRAIN-REPO-ON-FIRST-USE two brains never get the same repo, however long their names", () => {
    const tenant = "a-tenant-with-a-very-long-slug-indeed-xx";
    const a = repoName(tenant, "same-person-name-is-long-111111", "dev", "11111111-0000-0000-0000-000000000000");
    const b = repoName(tenant, "same-person-name-is-long-222222", "dev", "22222222-0000-0000-0000-000000000000");
    expect(a).not.toBe(b);
    for (const n of [a, b]) {
      expect(n.length).toBeLessThanOrEqual(64);
      expect(n.endsWith("-dev")).toBe(true);
    }
    expect(plainRemote("https://axiplex@dev.azure.com/axiplex/p/_git/r")).toBe("https://dev.azure.com/axiplex/p/_git/r");
  });
});
