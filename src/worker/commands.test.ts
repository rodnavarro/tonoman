import { describe, expect, it, vi } from "vitest";
import { parse, run, splitConnector, type CommandDeps, undecorate, CONNECT_KINDS, mergeConnections, canonicalModel } from "./commands";
import type { StatusMode } from "../statusline";

describe("parse", () => {
  it("accepts the ! prefix that actually reaches a Slack app", () => {
    expect(parse("!status")).toEqual({ name: "status", arg: "" });
    expect(parse("  !statusline full  ")).toEqual({ name: "statusline", arg: "full" });
  });

  it("does NOT accept /, because Slack owns that namespace", () => {
    // This used to be supported and never once worked. Slack intercepts an unregistered slash
    // command, answers with its own error, and never delivers the message — so `/model` has never
    // reached this function. Support that is real in the code and imaginary in practice is worse
    // than no support: it reads as a working path nobody can use.
    expect(parse("/model sonnet")).toBeUndefined();
  });

  it("takes ! and nothing else", () => {
    // `.` was briefly accepted too, for the Claude Code habit. Withdrawn on the reasoning that
    // settles it: that interception happens INSIDE Claude Code, before anything is sent, so a
    // second prefix here cannot help with a keystroke this code never sees.
    expect(parse("!connect plaud")).toEqual({ name: "connect", arg: "plaud" });
    expect(parse(".connect plaud")).toBeUndefined();
  });

  // OBSERVED. The agent's own not-signed-in notice says: Send `!connect claude`. Somebody copied
  // that line back, Slack delivered the backticks with it, nothing matched, and the message went to
  // a turn that could not run - so the reply was the same notice again, telling them to do the
  // thing they had just done. We wrote the instruction; the least we can do is accept it.
  it("reads a command that arrives wrapped in Slack formatting", () => {
    expect(parse("`!connect claude`")).toEqual({ name: "connect", arg: "claude" });
    expect(parse("```!connections```")).toEqual({ name: "connections", arg: "" });
    expect(parse("*!status*")).toEqual({ name: "status", arg: "" });
    expect(parse("`*!connect google*`")).toEqual({ name: "connect", arg: "google" });
  });

  it("takes off a whole wrap only, never punctuation inside the argument", () => {
    // An argument may legitimately contain a backtick or an underscore, and eating one would
    // corrupt a URL or an alias silently - worse than not matching at all.
    expect(parse("!connect ics my_cal")).toEqual({ name: "connect", arg: "ics my_cal" });
    expect(parse("!connect ics https://x/y?a=`b`")).toEqual({ name: "connect", arg: "ics https://x/y?a=`b`" });
    expect(undecorate("`not a command`")).toBe("not a command");
    expect(undecorate("plain text")).toBe("plain text");
  });

  it("still ignores ordinary prose that happens to start with punctuation", () => {
    expect(parse("... anyway, that worked")).toBeUndefined();
    expect(parse("!!! this broke")).toBeUndefined();
  });

  it("lower-cases the command but not the argument", () => {
    expect(parse("!MODEL Opus-4-8")).toEqual({ name: "model", arg: "Opus-4-8" });
  });

  it("leaves ordinary text alone", () => {
    expect(parse("what were we talking about?")).toBeUndefined();
    expect(parse("")).toBeUndefined();
    // A bare "!" or an emphatic sentence is not a command.
    expect(parse("!!!")).toBeUndefined();
    expect(parse("! status")).toBeUndefined();
  });
});

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  let mode: StatusMode = "small";
  return {
    getMode: () => mode,
    setMode: (_c, m) => {
      mode = m;
    },
    lastUsage: () => undefined,
    windows: async () => [{ key: "5h", usedPct: 9, resetAt: undefined }],
    getModel: () => "sonnet",
    setModel: () => {},
    ...over,
  };
}

describe("run", () => {
  it("NEVER lets an unknown command become a turn", async () => {
    // It used to return null here, handing `!connections` to the harness as ordinary text — and the
    // harness, being Claude Code, answered confidently about ITS OWN connectors: Google Drive,
    // Gmail, MCP. A plausible answer to a question nobody asked, about a different system. The
    // prefix is deliberate and learned, so anything wearing it is a command attempt.
    const out = await run(deps(), "nelly", "c", { name: "deploy", arg: "" });
    expect(out).not.toBeNull();
    expect(out).toContain("deploy");
    expect(out).toContain("!help");
  });

  it("suggests the command somebody was probably reaching for", async () => {
    // The real shape of the mistake: a longer or shorter form of a half-remembered command, not an
    // anagram of one.
    expect(await run(deps(), "nelly", "c", { name: "conn", arg: "" })).toContain("`!connect`");
    expect(await run(deps(), "nelly", "c", { name: "statuss", arg: "" })).toContain("`!status`");
  });

  it("lists connections by the name a person gave them, not by kind", async () => {
    // `Foley Outlook ICS` means something to somebody. `ics` does not.
    const d = {
      ...deps(),
      connections: async () => [
        { kind: "ics", alias: "foley", label: "Foley Outlook ICS", status: "connected" },
        { kind: "google", alias: "personal", status: "expired", externalAccount: "rod@rodnavarro.com" },
      ],
    };
    const out = (await run(d, "sapien", "c", { name: "connections", arg: "" })) ?? "";
    expect(out).toContain("Foley Outlook ICS");
    expect(out).toContain("rod@rodnavarro.com");
    // Flagged only when it is NOT working — a tick on every line trains people to stop reading.
    expect(out).toContain("expired");
    expect(out.match(/⚠️/g)?.length).toBe(1);
  });

  it("says plainly when nothing is connected", async () => {
    // An empty list and a broken lookup look identical if the answer is a blank line.
    const d = { ...deps(), connections: async () => [] };
    expect(await run(d, "sapien", "c", { name: "connections", arg: "" })).toContain("Nothing is connected");
  });

  it("does not invent a suggestion when there is nothing close", async () => {
    const out = await run(deps(), "nelly", "c", { name: "zzzz", arg: "" });
    expect(out).not.toContain("Did you mean");
  });

  it("answers !status from account headroom even before any turn has run", async () => {
    const out = await run(deps(), "nelly", "c", { name: "status", arg: "" });
    expect(out).toContain("5h: 9% used");
    expect(out).toContain("no turn has run in this thread yet".replace("no", "No"));
  });

  it("includes per-turn numbers once a turn has run", async () => {
    const out = await run(
      deps({ lastUsage: () => ({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 50 }) }),
      "nelly",
      "c",
      { name: "status", arg: "" },
    );
    expect(out).toContain("Usage — this turn");
  });

  it("sets and reports the statusline mode", async () => {
    const d = deps();
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "" })).toContain("*small*");
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "full" })).toContain("*full*");
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "" })).toContain("*full*");
  });

  it("refuses an unknown mode rather than silently keeping the old one", async () => {
    const d = deps();
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "loud" })).toContain("don't know");
    expect(d.getMode("c")).toBe("small");
  });

  it("reports the model and sets it for THIS conversation only", async () => {
    const setModel = vi.fn();
    const d = deps({ setModel });
    expect(await run(d, "nelly", "c", { name: "model", arg: "" })).toContain("*sonnet*");
    expect(await run(d, "nelly", "c", { name: "model", arg: "opus" })).toContain("next message");
    // The conversation is carried through, which is the whole point: one person changing the model
    // must not move it under everybody else the worker is serving.
    expect(setModel).toHaveBeenCalledWith("nelly", "c", "opus");
  });

  it("scopes the change to the conversation it was typed in", async () => {
    const setModel = vi.fn();
    const d = deps({ setModel });
    await run(d, "nelly", "celine-thread", { name: "model", arg: "opus" });
    expect(setModel).toHaveBeenCalledWith("nelly", "celine-thread", "opus");
    expect(setModel).not.toHaveBeenCalledWith("nelly", "rod-thread", "opus");
  });

  it("'default' clears the override rather than setting a model named default", async () => {
    const setModel = vi.fn();
    const d = deps({ setModel });
    expect(await run(d, "nelly", "c", { name: "model", arg: "default" })).toContain("default model");
    expect(setModel).toHaveBeenCalledWith("nelly", "c", undefined);
  });

  it("!new actually forgets the thread — it does not just describe forgetting", async () => {
    // It used to only print "I keep no memory across them", which was true when a thread had no
    // memory to keep. A thread now continues one harness session, so a `!new` that printed the
    // old text would be describing the behaviour of the release before it.
    const forgotten: string[][] = [];
    const out = await run(
      deps({ resetSession: (agent, conversation) => forgotten.push([agent, conversation]) }),
      "nelly",
      "c",
      { name: "new", arg: "" },
    );
    expect(forgotten).toEqual([["nelly", "c"]]);
    expect(out).toContain("Forgotten");
  });

  it("says how a fresh conversation is started when there is no session to forget", async () => {
    // A deployment with no session memory must not claim a reset it did not perform.
    const out = await run(deps(), "nelly", "c", { name: "new", arg: "" });
    expect(out).toContain("New chat");
    expect(out).not.toContain("Forgotten");
  });

  it("degrades to [] windows rather than failing when the runtime is unreachable", async () => {
    const d = deps({ windows: async () => { throw new Error("connect ECONNREFUSED"); } });
    const out = await run(d, "nelly", "c", { name: "status", arg: "" });
    expect(out).toContain("n/a");
  });
});

describe("connection commands name their connector", () => {
  it("splits the connector off the first word, leaving a pasted address intact", () => {
    // The callback address is one long token with its own `?` and `&`; splitting on anything but
    // the first space would tear it apart.
    const { which, rest } = splitConnector("plaud http://localhost:8199/auth/callback?code=abc&state=xyz");
    expect(which).toBe("plaud");
    expect(rest).toBe("http://localhost:8199/auth/callback?code=abc&state=xyz");
  });

  it("asks which one rather than assuming, even while there is only one", () => {
    // Calendars are next. A bare `!connect` that silently means Plaud today is a bare `!connect`
    // that means something else later, and every written instruction becomes wrong at that moment.
    expect(splitConnector("")).toEqual({ which: "", rest: "" });
  });

  it("takes a lone word as the connector with nothing after it", () => {
    expect(splitConnector("  PLAUD  ")).toEqual({ which: "plaud", rest: "" });
  });
});

describe("run — connecting a calendar provider", () => {
  const withOauth = (over: Partial<Record<string, unknown>> = {}) => ({
    ...deps(),
    beginOauth: async () => ({ url: "https://accounts.google.test/auth?x=1" }),
    ...over,
  });

  it("hands over a link and promises nothing has to come back", async () => {
    // The whole point of owning the redirect: a customer never copies a broken URL out of a
    // browser bar, which is what the Plaud flow still requires because that redirect is not ours.
    const out = (await run(withOauth(), "sapien", "c", { name: "connect", arg: "google" })) ?? "";
    expect(out).toContain("https://accounts.google.test/auth?x=1");
    expect(out).toContain("Nothing to copy back");
  });

  it("names the connection after what the person called it", async () => {
    let seen = "";
    const d = withOauth({ beginOauth: async (_a: string, _p: string, alias: string) => { seen = alias; return { url: "https://x.test" }; } });
    await run(d, "sapien", "c", { name: "connect", arg: "google work" });
    expect(seen).toBe("work");
  });

  it("slugs a name rather than refusing it", async () => {
    // Somebody types "My Work Calendar". The alias ends up inside a secret ref, so it has to be
    // safe — but rejecting the input would be a worse answer than cleaning it.
    let seen = "";
    const d = withOauth({ beginOauth: async (_a: string, _p: string, alias: string) => { seen = alias; return { url: "https://x.test" }; } });
    await run(d, "sapien", "c", { name: "connect", arg: "outlook  My Work Calendar!! " });
    expect(seen).toBe("my-work-calendar");
  });

  it("passes the registry's own reason through when it refuses", async () => {
    // The registry knows which providers are configured and this process does not, so paraphrasing
    // would turn a specific answer into a vague one.
    const d = withOauth({ beginOauth: async () => ({ problem: 'no "outlook" provider is configured (available: google)' }) });
    const out = (await run(d, "sapien", "c", { name: "connect", arg: "outlook" })) ?? "";
    expect(out).toContain("no \"outlook\" provider is configured");
  });

  it("still asks which one when given nothing", async () => {
    const out = (await run(withOauth(), "sapien", "c", { name: "connect", arg: "" })) ?? "";
    expect(out).toContain("google");
    expect(out).toContain("plaud");
  });
});

describe("every connector the agent offers is one it can actually run", () => {
  // THE bug this guards. `!connect claude` was refused with `I don't have a "claude" connector.
  // Today: plaud, google, outlook or claude.` — a sentence that lists the thing it is denying,
  // because the list lived in the message and the dispatch lived in a switch, and nothing made
  // them agree. It was reached by following the agent's own instruction to send that command.
  //
  // So the list is now the source, and this walks it. A connector added to CONNECT_KINDS without a
  // branch fails here rather than in front of somebody.
  const deps = {
    getMode: () => "compact",
    setMode: () => {},
    lastUsage: () => undefined,
    windows: async () => [],
    getModel: () => undefined,
    setModel: () => {},
    connectClaude: async () => "",
    connectPlaud: async () => "plaud login",
    beginOauth: async () => ({ url: "https://example.test/auth" }),
    plaudConnected: async () => false,
  } as unknown as Parameters<typeof run>[0];

  for (const kind of CONNECT_KINDS) {
    it(`!connect ${kind} is dispatched, not refused`, async () => {
      const out = await run(deps, "a", "c", { name: "connect", arg: kind });
      expect(out).not.toMatch(/don't have a/);
    });
  }

  it("still refuses one it really does not have, and names what it does", async () => {
    const out = await run(deps, "a", "c", { name: "connect", arg: "dropbox" });
    expect(out).toContain('I don\'t have a "dropbox" connector here');
    for (const kind of CONNECT_KINDS) expect(out).toContain(kind);
  });

  it("names only plaud for !code, which is the only one that takes a pasted address", async () => {
    const out = await run({ ...deps, finishPlaud: async () => "" } as never, "a", "c", { name: "code", arg: "google x" });
    expect(out).toContain("plaud");
    expect(out).not.toContain("outlook");
  });
});

describe("!connections answers from every store, not just the registry", () => {
  // THE bug: `!connect plaud` said "already connected" and `!connections`, one line later, said
  // "nothing is connected yet". Neither was wrong - the first asks the token store, the second
  // listed registry rows, and Plaud has never had one. A person cannot be expected to know which
  // question they just asked.
  const base = {
    getMode: () => "compact",
    setMode: () => {},
    lastUsage: () => undefined,
    windows: async () => [],
    getModel: () => undefined,
    setModel: () => {},
  } as unknown as Parameters<typeof run>[0];

  it("lists a Plaud account that only the token store knows about", async () => {
    const deps = {
      ...base,
      connections: async () => [],
      plaudConnected: async () => true,
    } as unknown as Parameters<typeof run>[0];
    const out = await run(deps, "a", "c", { name: "connections", arg: "" });
    expect(out).toContain("Plaud account");
    expect(out).not.toContain("Nothing is connected yet");
  });

  it("lists the Claude subscription, which an agent is plainly connected to", async () => {
    const deps = {
      ...base,
      connections: async () => [],
      claudeAccount: async () => "rod@rodnavarro.com (max)",
    } as unknown as Parameters<typeof run>[0];
    const out = await run(deps, "a", "c", { name: "connections", arg: "" });
    expect(out).toContain("Claude subscription");
    expect(out).toContain("rod@rodnavarro.com (max)");
  });

  it("says nothing about Claude when the agent is not signed in", async () => {
    const deps = {
      ...base,
      connections: async () => [],
      claudeAccount: async () => "not signed in",
    } as unknown as Parameters<typeof run>[0];
    const out = await run(deps, "a", "c", { name: "connections", arg: "" });
    expect(out).toContain("Nothing is connected yet");
  });

  it("shows a calendar and a legacy credential together", async () => {
    const deps = {
      ...base,
      connections: async () => [{ kind: "ics", alias: "foley", label: "Foley Outlook ICS", status: "connected" }],
      plaudConnected: async () => true,
    } as unknown as Parameters<typeof run>[0];
    const out = await run(deps, "a", "c", { name: "connections", arg: "" });
    expect(out).toContain("Foley Outlook ICS");
    expect(out).toContain("Plaud account");
    expect(out).toContain("2 things");
  });

  it("names the connectors it has when there is nothing to list", async () => {
    const deps = { ...base, connections: async () => [] } as unknown as Parameters<typeof run>[0];
    const out = await run(deps, "a", "c", { name: "connections", arg: "" });
    // The old copy hardcoded "!connect plaud" and pre-dated calendars entirely.
    for (const kind of ["claude", "plaud", "google", "outlook"]) expect(out).toContain(`!connect ${kind}`);
  });

  it("does not let a broken token store hide the calendars that DO work", async () => {
    const deps = {
      ...base,
      connections: async () => [{ kind: "ics", alias: "foley", label: "Foley Outlook ICS", status: "connected" }],
      plaudConnected: async () => {
        throw new Error("token store unreadable");
      },
    } as unknown as Parameters<typeof run>[0];
    const out = await run(deps, "a", "c", { name: "connections", arg: "" });
    expect(out).toContain("Foley Outlook ICS");
  });
});

describe("mergeConnections", () => {
  it("lets the registry win on any kind it holds, so the bridge retires itself", async () => {
    // When Plaud moves onto the connection model its legacy entry stops being reachable and
    // nothing else has to change. That is what keeps this a bridge rather than a second source.
    const merged = mergeConnections(
      [{ kind: "plaud", alias: "default", label: "Plaud (registry)" }],
      [{ kind: "plaud", alias: "default", label: "Plaud (token store)" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.label).toBe("Plaud (registry)");
  });

  it("keeps every registry row, including two of one kind", async () => {
    const merged = mergeConnections(
      [
        { kind: "google", alias: "work" },
        { kind: "google", alias: "personal" },
      ],
      [{ kind: "plaud", alias: "default" }],
    );
    expect(merged.map((c) => `${c.kind}/${c.alias}`)).toEqual(["google/work", "google/personal", "plaud/default"]);
  });
});

describe("canonicalModel", () => {
  it("maps a versioned marketing name to the SPECIFIC id — the opus-5 footgun", () => {
    // The string a person typed off the Hub's "Claude Opus 5" label, which the CLI rejects as-is but
    // accepts as claude-opus-5.
    expect(canonicalModel("opus-5")).toBe("claude-opus-5");
    expect(canonicalModel("Opus 5")).toBe("claude-opus-5");
    expect(canonicalModel("opus5")).toBe("claude-opus-5");
    expect(canonicalModel("sonnet-5")).toBe("claude-sonnet-5");
    expect(canonicalModel("haiku 4.5")).toBe("claude-haiku-4-5");
  });

  it("preserves the version — opus-4-8 is 4.8, not silently the latest opus", () => {
    expect(canonicalModel("opus-4-8")).toBe("claude-opus-4-8");
    expect(canonicalModel("opus 4.8")).toBe("claude-opus-4-8");
    expect(canonicalModel("opus-4.8")).toBe("claude-opus-4-8");
  });

  it("leaves the bare aliases alone — they are the future-proof 'latest of the family'", () => {
    for (const a of ["opus", "sonnet", "haiku"]) expect(canonicalModel(a)).toBe(a);
    expect(canonicalModel("OPUS")).toBe("opus");
  });

  it("passes a full claude- id and anything unknown through unchanged — the harness owns the list", () => {
    // Rod's case: a specific id typed directly must never be mangled.
    expect(canonicalModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(canonicalModel("claude-opus-5")).toBe("claude-opus-5");
    expect(canonicalModel("us.anthropic.claude-sonnet-4-6")).toBe("us.anthropic.claude-sonnet-4-6");
    expect(canonicalModel("banana")).toBe("banana");
  });
});

describe("run — !model normalises the marketing name", () => {
  it("sets the specific id for opus-5, and shows the normalisation", async () => {
    const setModel = vi.fn();
    const out = await run(deps({ setModel }), "sapien", "t", { name: "model", arg: "opus-5" });
    expect(setModel).toHaveBeenCalledWith("sapien", "t", "claude-opus-5");
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("opus-5"); // the "opus-5 → claude-opus-5" note
  });

  it("leaves a full id a person pasted untouched", async () => {
    const setModel = vi.fn();
    await run(deps({ setModel }), "sapien", "t", { name: "model", arg: "claude-opus-4-8" });
    expect(setModel).toHaveBeenCalledWith("sapien", "t", "claude-opus-4-8");
  });
});
