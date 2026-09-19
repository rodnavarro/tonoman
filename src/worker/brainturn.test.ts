// A whole conversation turn, with brains: what is shown while it works, and where the answer goes.
// The Temporal activity context is faked; the turn itself is the real one. Titles start with the
// rule they prove (docs/definition/objects/brain.md in Tonoman Cloud).
import { describe, it, expect, vi, beforeEach } from "vitest";

const ctx = { cancellationSignal: new AbortController().signal, cancelled: new Promise<never>(() => {}), heartbeat: () => {} };
vi.mock("@temporalio/activity", () => ({ Context: { current: () => ctx } }));

import { makeActivities, sessionKeyOf, type TurnBrains, type TurnRunReq } from "./activities";
import { THREAD_NOTE, THREAD_NOTE_FAILED, type Audience } from "../brains/delivery";
import type { TurnEvent } from "../core/contracts";

/** Everything the turn did to the channel, in order. */
let posted: { op: string; id?: string; text?: string | null }[];
let dms: { user: string; text: string }[];
let requests: TurnRunReq[];
let claimed: string[];

interface Scenario {
  audience: Audience;
  /** The audience when it is counted again, just before posting. Defaults to `audience`. */
  audienceAtEnd?: Audience;
  /** The model fails with this message instead of answering. */
  fails?: string;
  /** Brains the fake agent "uses" during the turn. */
  uses: string[];
  answer: string;
  /** What the registry says every member can read. */
  readable?: string[];
  /** Or: what it says, given who the members are. */
  readableFor?: (members: string[], ids: string[]) => string[];
  /** What the speaker reaches at the start and at the end. */
  reachAtStart?: Record<string, string>;
  reachAtEnd?: Record<string, string>;
  dmWorks?: boolean;
}

function build(sc: Scenario, provenanceStore = new Map<string, string[]>()) {
  let finished = false;
  let audienceCalls = 0;
  const tokens = new Map<string, { used: string[]; key: string }>();
  const brains: TurnBrains = {
    start: (_agent, user, _who, key) => {
      const token = `t-${user}-${tokens.size}`;
      tokens.set(token, { used: [], key });
      return { token, mcp: { name: "brain", command: "node", args: ["shim"], env: { TONOMAN_BRAIN_TOKEN: token } } };
    },
    end: (token) => {
      const t = tokens.get(token);
      tokens.delete(token);
      return t?.used ?? [];
    },
    provenance: async (_a, key) => provenanceStore.get(key) ?? [],
    remember: async (_a, key, used) => void provenanceStore.set(key, [...new Set([...(provenanceStore.get(key) ?? []), ...used])]),
    audience: async () => (audienceCalls++ === 0 ? sc.audience : sc.audienceAtEnd ?? sc.audience),
    reach: async () => {
      // Before the model has finished, the speaker reaches `reachAtStart`; after, `reachAtEnd`.
      const r = finished ? sc.reachAtEnd ?? sc.reachAtStart : sc.reachAtStart;
      return new Map(Object.entries(r ?? { "b-ana": "Ana's brain", "b-eng": "Engineering" }));
    },
    readableByAll: async (_a, ids, members) => (sc.readableFor ? sc.readableFor(members, ids) : sc.readable ?? []),
    dm: async (user, _u, text) => {
      if (sc.dmWorks === false) return false;
      dms.push({ user: _u, text });
      return true;
    },
  };
  let n = 0;
  const reply = {
    send: async (text: string) => {
      const id = `m${++n}`;
      posted.push({ op: "send", id, text });
      return id;
    },
    update: async (id: string, text: string) => void posted.push({ op: "update", id, text }),
    finalize: async (id: string, text: string) => void posted.push({ op: "finalize", id, text }),
    canEdit: () => true,
    working: async (status?: string) => void posted.push({ op: "working", text: status }),
    settle: async () => void posted.push({ op: "settle" }),
    note: async (id: string | undefined, text: string | null) => {
      posted.push({ op: "note", id, text });
      return id ?? `n${++n}`;
    },
  };
  const run = async function* (req: TurnRunReq): AsyncIterable<TurnEvent> {
    requests.push(req);
    const token = req.mcpServers?.[0]?.env.TONOMAN_BRAIN_TOKEN;
    yield { kind: "tool", tool: "mcp__brain__brain_read", text: "Ana's brain · AI/jev.md" } as TurnEvent;
    if (token) {
      // As the real broker does: each use is recorded with the session the moment it happens.
      const t = tokens.get(token)!;
      t.used.push(...sc.uses);
      if (sc.uses.length) await brains.remember("echo", t.key, sc.uses);
    }
    if (sc.fails) throw new Error(sc.fails);
    // Slow enough that a streaming turn would have shown partial text.
    for (const word of sc.answer.split(" ")) {
      yield { kind: "text", text: `${word} ` } as TurnEvent;
      await new Promise((r) => setTimeout(r, 5));
    }
    finished = true;
    yield { kind: "done", final: sc.answer } as TurnEvent;
  };
  const acts = makeActivities({
    agent: () => ({
      cfg: { name: "echo", guid: "g-echo", principals: [{ kind: "slack_user_id", value: "UANA", label: "Ana" }] } as never,
      conn: { reply: () => reply } as never,
      run,
    }),
    brains,
    claimSession: async (_agent: string, key: string) => {
      claimed.push(key);
      return { id: `s-${key}`, isNew: true };
    },
    resetSession: async (_agent: string, key: string) => {
      claimed.push(`reset:${key}`);
      return { id: `s2-${key}`, isNew: true };
    },
  } as never);
  return { acts, provenanceStore };
}

const turn = (conversation: string, user = "UANA", text = "what do we know about Jev?") => ({
  agent: "echo",
  conversation,
  channel: "slack",
  text,
  user,
});
const inThread = () => posted.filter((p) => ["send", "update", "finalize"].includes(p.op)).map((p) => p.text ?? "");

beforeEach(() => {
  posted = [];
  dms = [];
  requests = [];
  claimed = [];
});

describe("where the answer goes", () => {
  it("BRAIN-PRIVATE-DELIVERY in a public channel an answer from a brain goes by DM, saying why; the thread gets one line", async () => {
    const { acts } = build({ audience: { kind: "public", name: "general" }, uses: ["b-ana"], answer: "Jev is TypeSafe's first model." });
    await acts.runTurn(turn("T/C1/1"));
    expect(dms).toHaveLength(1);
    expect(dms[0].user).toBe("UANA");
    expect(dms[0].text).toMatch(/^_Answering here because part of this comes from Ana's brain, and #general is public/);
    expect(dms[0].text).toContain("Jev is TypeSafe's first model.");
    expect(inThread()).toEqual([THREAD_NOTE]);
  });

  it("BRAIN-PRIVATE-DELIVERY while a held turn works, nothing of the answer or its tools is shown", async () => {
    const { acts } = build({ audience: { kind: "public", name: "general" }, uses: ["b-ana"], answer: "secret words here" });
    await acts.runTurn(turn("T/C1/1"));
    const everything = JSON.stringify(posted);
    expect(everything).not.toContain("secret");
    expect(everything).not.toContain("AI/jev.md");
  });

  it("BRAIN-PRIVATE-DELIVERY in the speaker's own DM the answer streams and lands there as always", async () => {
    const { acts } = build({ audience: { kind: "self" }, uses: ["b-ana"], answer: "one two three four five six seven eight" });
    await acts.runTurn(turn("T/D1"));
    expect(dms).toEqual([]);
    expect(inThread().at(-1)).toContain("one two three four five six seven eight");
  });

  it("BRAIN-PRIVATE-DELIVERY a private channel whose every member can read the brains used keeps the answer", async () => {
    const { acts } = build({ audience: { kind: "members", members: ["UANA", "UBEN"], name: "eng" }, uses: ["b-eng"], readable: ["b-eng"], answer: "From Engineering." });
    await acts.runTurn(turn("T/G1/1"));
    expect(dms).toEqual([]);
    expect(inThread().at(-1)).toContain("From Engineering.");
  });

  it("BRAIN-PRIVATE-DELIVERY an answer that used no brain stays in the thread", async () => {
    const { acts } = build({ audience: { kind: "public", name: "general" }, uses: [], answer: "Hello." });
    await acts.runTurn(turn("T/C1/1"));
    expect(dms).toEqual([]);
    expect(inThread().at(-1)).toContain("Hello.");
  });

  it("BRAIN-PRIVATE-DELIVERY if the DM cannot be sent, the thread says so and never shows the answer", async () => {
    const { acts } = build({ audience: { kind: "public" }, uses: ["b-ana"], answer: "private stuff", dmWorks: false });
    await acts.runTurn(turn("T/C1/1"));
    expect(inThread()).toEqual([THREAD_NOTE_FAILED]);
    expect(JSON.stringify(posted)).not.toContain("private stuff");
  });
});

describe("what the conversation remembers", () => {
  it("BRAIN-USED-DECIDES a follow-up that looks nothing up is still private once the history drew on a private brain", async () => {
    const store = new Map<string, string[]>();
    const first = build({ audience: { kind: "public" }, uses: ["b-ana"], answer: "From Ana's brain." }, store);
    await first.acts.runTurn(turn("T/C1/1"));
    dms = [];
    posted = [];
    const second = build({ audience: { kind: "public" }, uses: [], answer: "As I said, the waitlist." }, store);
    await second.acts.runTurn(turn("T/C1/1", "UANA", "remind me?"));
    expect(dms).toHaveLength(1);
    expect(inThread()).toEqual([THREAD_NOTE]);
  });

  it("BRAIN-USED-DECIDES another person's history of the same thread starts clean", async () => {
    const store = new Map<string, string[]>();
    await build({ audience: { kind: "public" }, uses: ["b-ana"], answer: "x" }, store).acts.runTurn(turn("T/C1/1", "UANA"));
    expect(store.get(sessionKeyOf("T/C1/1", "UANA"))).toEqual(["b-ana"]);
    expect(store.get(sessionKeyOf("T/C1/1", "UBEN"))).toBeUndefined();
  });
});

describe("whose history", () => {
  it("BRAIN-NO-DISCLOSURE each person continues their own session of a thread", async () => {
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "hi" });
    await acts.runTurn(turn("T/C1/1", "UANA"));
    await acts.runTurn(turn("T/C1/1", "UBEN"));
    expect(claimed).toEqual(["T/C1/1#UANA", "T/C1/1#UBEN"]);
  });
});

describe("the turn's tools and folder", () => {
  it("BRAIN-EVERY-AGENT every person's turn is handed the brain tool, in its own working folder", async () => {
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "hi" });
    await acts.runTurn(turn("T/D1"));
    expect(requests[0].mcpServers?.[0]).toMatchObject({ name: "brain", command: "node" });
    expect(requests[0].cwd).toMatch(/tonoman-turn-/);
    expect(requests[0].prompt).toMatch(/brain_list/);
  });

  it("BRAIN-GRANT-TIMING if the speaker lost a brain while the turn worked, nothing new from it is sent", async () => {
    const { acts } = build({
      audience: { kind: "public" },
      uses: ["b-eng"],
      answer: "Engineering's secret plan.",
      reachAtStart: { "b-eng": "Engineering" },
      reachAtEnd: {},
    });
    await acts.runTurn(turn("T/C1/1"));
    expect(JSON.stringify([...posted, ...dms])).not.toContain("secret plan");
  });
});

describe("found in review", () => {
  it("BRAIN-GRANT-TIMING a history that drew on a brain the person no longer reaches is not resumed", async () => {
    const store = new Map([[sessionKeyOf("T/D1", "UANA"), ["b-gone"]]]);
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "hi", reachAtStart: { "b-ana": "Ana's brain" } }, store);
    await acts.runTurn(turn("T/D1"));
    expect(claimed).toEqual(["reset:T/D1#UANA"]);
    expect(requests[0].prompt).toMatch(/conversation was restarted because the person's access to a brain changed/);
  });

  it("BRAIN-PRIVATE-DELIVERY a held turn that fails says nothing of what it had read", async () => {
    const { acts } = build({ audience: { kind: "public" }, uses: ["b-ana"], answer: "x", fails: "tool said: Jev is TypeSafe's secret model" });
    await expect(acts.runTurn(turn("T/C1/1"))).rejects.toThrow(/^The answer could not be finished/);
    expect(JSON.stringify(posted)).not.toContain("secret model");
  });

  it("BRAIN-AUDIENCE the audience is counted again just before posting: someone who joined meanwhile sends it private", async () => {
    const { acts } = build({
      audience: { kind: "members", members: ["UANA"], name: "eng" },
      audienceAtEnd: { kind: "members", members: ["UANA", "UNEW"], name: "eng" },
      uses: ["b-ana"],
      answer: "private words",
      // Ana alone can read her brain; the newcomer cannot.
      readableFor: (members, ids) => (members.includes("UNEW") ? [] : ids),
    });
    await acts.runTurn(turn("T/G1/1"));
    expect(dms).toHaveLength(1);
    expect(inThread()).toEqual([THREAD_NOTE]);
  });

  it("BRAIN-GRANT-TIMING even in the speaker's own DM, an answer drawing on a brain they lost mid-turn is withheld", async () => {
    const { acts } = build({ audience: { kind: "self" }, uses: ["b-eng"], answer: "Engineering's secret plan.", reachAtStart: { "b-eng": "Engineering" }, reachAtEnd: {} });
    await acts.runTurn(turn("T/D1"));
    expect(inThread().at(-1)).toMatch(/can't share that answer/);
    expect(inThread().at(-1)).not.toContain("secret plan");
  });
});

describe("what a Talent announces", () => {
  const announce = (conversation: string, drewOn: string[]) => ({ ...turn(conversation, "UANA", "Announce the recap"), fromSystem: true, drewOn });

  it("BRAIN-PRIVATE-CONFIRMATIONS a recap filed into a brain the channel cannot read is announced to its person by DM", async () => {
    const { acts } = build({ audience: { kind: "public", name: "sapien-dev" }, uses: [], answer: "Recap: planned the offsite." });
    await acts.runTurn(announce("T/C1/9", ["b-ana"]));
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toContain("Recap: planned the offsite.");
    expect(inThread()).toEqual([THREAD_NOTE]);
  });

  it("BRAIN-PRIVATE-CONFIRMATIONS a filing is not announced at all to a person who cannot read the brain it went into", async () => {
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "Recap: Engineering's secret plan.", reachAtStart: { "b-ana": "Ana's brain" } });
    await acts.runTurn(announce("D1", ["b-eng"]));
    expect(requests).toHaveLength(0);
    expect(inThread()).toEqual([]);
    expect(dms).toEqual([]);
  });

  it("BRAIN-PRIVATE-CONFIRMATIONS an announcement naming nobody to tell says nothing", async () => {
    const { acts } = build({ audience: { kind: "public", name: "sapien-dev" }, uses: [], answer: "Recap: Engineering's secret plan." });
    await acts.runTurn({ ...announce("T/C1/9", ["b-eng"]), user: "" });
    expect(requests).toHaveLength(0);
    expect(inThread()).toEqual([]);
  });

  it("BRAIN-PRIVATE-CONFIRMATIONS even in the person's own DM an announcement is not streamed before its final check", async () => {
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "one two three four five six seven eight nine ten", reachAtStart: { "b-eng": "Engineering" }, reachAtEnd: {} });
    await acts.runTurn(announce("D1", ["b-eng"]));
    expect(posted.filter((p) => p.op === "update")).toEqual([]);
    expect(inThread().join(" ")).not.toMatch(/\bone\b/);
  });

  it("BRAIN-PRIVATE-CONFIRMATIONS in a private channel whose members all read that brain, it is announced there", async () => {
    const { acts } = build({ audience: { kind: "members", members: ["UANA", "UBEN"], name: "eng" }, uses: [], readable: ["b-eng"], answer: "Recap: shipped." });
    await acts.runTurn(announce("T/G1/9", ["b-eng"]));
    expect(dms).toEqual([]);
    expect(inThread().at(-1)).toContain("Recap: shipped.");
  });
});

describe("files someone attaches", () => {
  const fsp = () => import("node:fs/promises");
  const tmp = async () => {
    const { mkdtemp } = await fsp();
    const os = await import("node:os");
    const path = await import("node:path");
    return mkdtemp(path.join(os.tmpdir(), "media-"));
  };

  it("CONVO-FILES-IN-THE-TURN an attached file is handed to the agent inside the turn's own folder, which is its working directory", async () => {
    const { writeFile } = await fsp();
    const path = await import("node:path");
    const media = path.join(await tmp(), "receipt.jpg");
    await writeFile(media, "jpeg bytes");
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "Filed." });
    await acts.runTurn({ ...turn("D1"), mediaPaths: [media] } as never);
    const req = requests[0]!;
    expect(req.mediaPaths).toHaveLength(1);
    expect(path.dirname(req.mediaPaths![0]!)).toBe(req.cwd);
    expect(req.mediaPaths![0]).not.toBe(media);
    expect(req.prompt).toContain(req.mediaPaths![0]!);
  });

  it("CONVO-FILES-IN-THE-TURN a file that could not be placed in the turn's folder is never handed over by a path the agent may not read", async () => {
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "Nothing to read." });
    await acts.runTurn({ ...turn("D1"), mediaPaths: ["/root/.tonoman/media/echo/gone.jpg"] } as never);
    const req = requests[0]!;
    expect(req.mediaPaths ?? []).toEqual([]);
    expect(req.prompt).not.toContain("/root/.tonoman");
    expect(req.prompt).toMatch(/could not be opened/i);
  });

  it("CONVO-FILES-IN-THE-TURN the turn's folder, with the file in it, is gone when the turn ends", async () => {
    const { writeFile, access } = await fsp();
    const path = await import("node:path");
    const media = path.join(await tmp(), "receipt.jpg");
    await writeFile(media, "jpeg bytes");
    const { acts } = build({ audience: { kind: "self" }, uses: [], answer: "Filed." });
    await acts.runTurn({ ...turn("D1"), mediaPaths: [media] } as never);
    await expect(access(requests[0]!.cwd!)).rejects.toThrow();
  });
});
