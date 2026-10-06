// Copies of a tool on one agent (D-TOOL-COPIES in Tonoman Cloud): `plaud-2`, `lorealistar-2` — each
// with each person's own login for it, connected with `!connect <copy>` and kept apart from the one
// they connected for the first copy.
import { describe, expect, it } from "vitest";
import { run, type CommandDeps } from "./commands";
import { slotKey, personOf, copyOf } from "./tokenstore";
import { ask, handleInteraction, LOREALISTAR_CONNECT_ACTION, type LorealistarGateDeps } from "./lorealistargate";
import { dropWatcher, memoryDropStore } from "./lorealistar";
import { makeActivities, type TurnDeps } from "./activities";
import { plaudLogins, pickLogin, skillsNote } from "./localtools";
import type { SlackConnector, SlackInteraction } from "../connector/slack";
import type { AgentConfig } from "../config";

const deps = (over: Partial<CommandDeps> = {}): CommandDeps => ({
  getMode: () => "small",
  setMode: () => {},
  lastUsage: () => undefined,
  windows: async () => [],
  getModel: () => "sonnet",
  setModel: () => {},
  toolCopyKind: (_a, w) => ({ "plaud-2": "plaud", "lorealistar-2": "lorealistar" })[w],
  ...over,
});

describe("a login for a copy of a tool", () => {
  it("TOOL-COPY-WHOSE-ACCOUNT the key a copy's login is kept under names the copy; the first copy's is the bare person", () => {
    expect(slotKey("plaud-2", "UANA0001")).toBe("plaud-2:UANA0001");
    expect(slotKey(undefined, "UANA0001")).toBe("UANA0001");
    expect(personOf("plaud-2:UANA0001")).toBe("UANA0001");
    expect(copyOf("plaud-2:UANA0001")).toBe("plaud-2");
    expect(copyOf("UANA0001")).toBeUndefined();
  });

  it("TOOL-COPY-WHOSE-ACCOUNT `!connect plaud-2` connects the speaker's own login for plaud-2, apart from their plaud", async () => {
    const asked: (string | undefined)[] = [];
    const d = deps({ connectPlaud: async (_a, _c, user) => (asked.push(user), ""), plaudConnected: async (_a, user) => user === "UANA0001" });
    expect(await run(d, "rex", "D1", { name: "connect", arg: "plaud-2" }, "UANA0001")).toBe("");
    expect(asked).toEqual(["plaud-2:UANA0001"]);
    // Connected for plaud is not connected for plaud-2; connected for plaud-2 says so, by name.
    const again = await run(deps({ connectPlaud: async () => "", plaudConnected: async (_a, u) => u === "plaud-2:UANA0001" }), "rex", "D1", { name: "connect", arg: "plaud-2" }, "UANA0001");
    expect(again).toContain("!connect plaud-2 again");
  });

  it("TOOL-COPY-WHOSE-ACCOUNT `!connect lorealistar-2` offers the dialog for that copy; `!disconnect plaud-2` forgets only that one", async () => {
    const offered: (string | undefined)[] = [];
    const forgot: (string | undefined)[] = [];
    const d = deps({ connectLorealistar: async (_a, _c, copy) => (offered.push(copy), ""), disconnectPlaud: async (_a, u) => (forgot.push(u), "ok") });
    await run(d, "mia", "D1", { name: "connect", arg: "lorealistar-2" }, "USTEF001");
    await run(d, "mia", "D1", { name: "disconnect", arg: "plaud-2" }, "USTEF001");
    expect(offered).toEqual(["lorealistar-2"]);
    expect(forgot).toEqual(["plaud-2:USTEF001"]);
  });

  it("DROPS-OWN-LOGIN the LOREALISTAR dialog for a copy keeps the login under that copy, and tells the person who filled it in", async () => {
    const posted: unknown[] = [];
    const opened: Record<string, unknown>[] = [];
    const saved: string[] = [];
    const told: string[] = [];
    const conn = { postBlocks: async (_c: string, _t: string, b: unknown[]) => void posted.push(b), call: async (_m: string, body: Record<string, unknown>) => (opened.push(body), {}) } as unknown as SlackConnector;
    const g: LorealistarGateDeps = { conn: () => conn, save: async (_a, user) => (saved.push(user), { ok: true, message: "Connected." }), tell: async (_a, user) => void told.push(user) };
    await ask(g, "mia", "D1", "lorealistar-2");
    const button = JSON.stringify(posted[0]);
    expect(button).toContain("lorealistar-2");
    const value = JSON.parse(button.match(/"value":"((?:\\"|[^"])*)"/)![1]!.replace(/\\"/g, '"')) as string | { c: string; copy: string };
    await handleInteraction(g, "mia", { kind: "block_actions", actionId: LOREALISTAR_CONNECT_ACTION, triggerId: "t", value: typeof value === "string" ? value : JSON.stringify(value) } as SlackInteraction);
    const view = opened[0]!.view as { private_metadata: string };
    await handleInteraction(g, "mia", {
      kind: "view_submission",
      callbackId: LOREALISTAR_CONNECT_ACTION,
      privateMetadata: view.private_metadata,
      userId: "USTEF001",
      values: { email: { value: { value: "test+stef@tonoman.com" } }, password: { value: { value: "pw-not-real" } } },
    } as SlackInteraction);
    expect(saved).toEqual(["lorealistar-2:USTEF001"]);
    expect(told).toEqual(["USTEF001"]);
  });
});

describe("the drop watch, per copy", () => {
  it("TOOL-COPY-WITH-SKILL-COPY each login is looked at for the drop-watch copy that uses its tool copy, and told where that copy says", async () => {
    const deps = {
      lorealistar: {
        users: async () => ["USTEF001", "lorealistar-2:USTEF001", "lorealistar-9:USTEF001"],
        lookFor: async () => ({ news: [{ id: "a", name: "Serum" }] }),
        told: async () => {},
        drop: async () => undefined,
      },
      dropCopy: (_a: string, key: string) =>
        key === "USTEF001" ? { person: "USTEF001", channel: "C-DROPS" } : key === "lorealistar-2:USTEF001" ? { person: "USTEF001", instance: "drop-watch-2", channel: "C-TWO" } : null,
    } as unknown as TurnDeps;
    const looks = await makeActivities(deps).dropLooks({ agent: "mia" });
    expect(looks.map((l) => [l.user, l.person, l.instance, l.channel])).toEqual([
      ["USTEF001", "USTEF001", undefined, "C-DROPS"],
      ["lorealistar-2:USTEF001", "USTEF001", "drop-watch-2", "C-TWO"],
    ]);
  });

  it("DROPS-OWN-LOGIN a drop found on a person's login for a copy is theirs to read in its run", async () => {
    const store = memoryDropStore();
    const w = dropWatcher({
      store,
      site: { signIn: async () => ({ ok: true, session: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }), renew: async () => ({ ok: false, why: "x" }) as never, list: async () => ({ ok: true, campaigns: [{ id: "d1", type: "DROP", name: "Serum", status: "Active", initial_qty: 10, claimed_qty: 1 }] }) } as never,
    });
    expect((await w.connect("mia", "lorealistar-2:USTEF001", "test+stef@tonoman.com", "pw")).ok).toBe(true);
    await w.lookFor("mia", "lorealistar-2:USTEF001");
    expect(await w.drop("mia", "USTEF001", "d1")).toBeTruthy();
    expect(await w.drop("mia", "UANA0001", "d1")).toBeUndefined();
  });
});

describe("a copy in chat", () => {
  const cfg = {
    skills: [
      { name: "meeting-recap", version: 1, bindings: { plaud: { mode: "each_person", copy: "plaud", credentials: [] } } },
      {
        name: "meeting-recap",
        instance: "meeting-recap-2",
        version: 1,
        bindings: {
          plaud: {
            mode: "each_person",
            copy: "plaud-2",
            credentials: [{ id: "c2", kind: "plaud", alias: "plaud-2", scope: "per_person", accounts: [{ secret_ref: "plaud.tokens:plaud-2:UANA0001", status: "connected" }, { secret_ref: "plaud.tokens:plaud-2:UBEN0001", status: "connected" }] }],
          },
        },
      },
    ],
  } as unknown as AgentConfig;

  it("TOOL-CALLED-BY-LABEL a person's own login for plaud-2 is named by the copy's keyword, and nobody else's is offered", () => {
    const logins = plaudLogins(cfg, { accounts: [{ user: "UANA0001", creds: {} }] } as never, "UANA0001");
    expect(logins.map((l) => l.label)).toEqual(["mine", "plaud-2"]);
    expect(pickLogin(logins, "plaud-2")).toMatchObject({ label: "plaud-2", secretRef: "plaud.tokens:plaud-2:UANA0001", own: true });
    expect(plaudLogins(cfg, undefined, "UZED0001").map((l) => l.label)).not.toContain("plaud-2");
  });

  it("TOOL-CALLED-BY-LABEL the agent is told each copy's keyword and how to name its login", () => {
    const note = skillsNote(cfg, () => undefined);
    expect(note).toContain("`meeting-recap-2` (a copy of meeting-recap)");
    expect(note).toContain('plaud-2: each person\'s own login for plaud-2 (--login "plaud-2")');
  });
});
