// How often the drop watcher looks, and how gently (drop-watch.md in Tonoman Cloud).
import { describe, it, expect } from "vitest";
import { dropEveryMinutes, DEFAULT_DROP_MINUTES, dropWatch, dropChannel } from "./drop-watch";
import { manifest, manifest as talentManifest } from "../../talents/lorealistar/drop-watch/manifest";
import { dropWatcher, memoryDropStore } from "../lorealistar";
import { dropRunId } from "../workflows";

describe("how often it looks", () => {
  it("DROPS-HOW-OFTEN every five minutes unless the Talent's setting says otherwise — and never so often that it hammers the site, nor so rarely that a drop is gone before it looks", () => {
    expect(DEFAULT_DROP_MINUTES).toBe(5);
    for (const unset of [undefined, "", "  ", "soon", null, {}]) expect(dropEveryMinutes(unset)).toBe(5);
    expect(dropEveryMinutes("10")).toBe(10);
    expect(dropEveryMinutes(3)).toBe(3);
    expect(dropEveryMinutes("0")).toBe(2);
    expect(dropEveryMinutes("0.2")).toBe(2);
    expect(dropEveryMinutes("999")).toBe(60);
  });

  it("DROPS-HOW-OFTEN the Talent the worker registers and the one it starts are the same Talent, and it says it runs on a timer", () => {
    expect(dropWatch.name).toBe(manifest.name);
    expect(dropWatch.version).toBe(manifest.version);
    expect(dropWatch.schedule?.kind).toBe("interval");
    expect(dropWatch.configSchema.map((f) => f.key)).toEqual(manifest.configSchema.map((f) => f.key));
  });

  it("DROPS-TOLD-ONCE a drop's announcement is one run per person per drop, however often it is seen — and a drop's id cannot name anything else", () => {
    expect(dropRunId("mia", "USTEF", "abc-123")).toBe("talent:mia:USTEF:drop-abc-123");
    expect(dropRunId("mia", "USTEF", "abc-123")).toBe(dropRunId("mia", "USTEF", "abc-123"));
    expect(dropRunId("mia", "UANA", "abc-123")).not.toBe(dropRunId("mia", "USTEF", "abc-123"));
    expect(dropRunId("mia", "USTEF", "a:b/c d")).toBe("talent:mia:USTEF:drop-a_b_c_d");
  });
});

describe("gently", () => {
  it("DROPS-GENTLE never more than one look at a time for one person: a second asked for meanwhile waits, and then uses the session the first one got — one sign-in, not two", async () => {
    const calls: string[] = [];
    let inFlight = 0;
    let most = 0;
    const w = dropWatcher({
      store: memoryDropStore(),
      now: () => Date.parse("2026-09-20T13:00:00Z"),
      site: {
        signIn: async () => (calls.push("signIn"), { ok: true, session: { accessToken: "a", refreshToken: "r", expiresAt: Date.parse("2026-09-20T14:00:00Z") } }),
        renew: async () => (calls.push("renew"), { ok: false, expired: true, why: "x" }),
        list: async () => {
          most = Math.max(most, ++inFlight);
          await new Promise((r) => setTimeout(r, 40));
          inFlight--;
          calls.push("list");
          return { ok: true, campaigns: [] };
        },
      },
    });
    await w.connect("mia", "USTEF", "test+stef@tonoman.com", "pw-not-real");
    await Promise.all([w.lookFor("mia", "USTEF"), w.lookFor("mia", "USTEF"), w.lookFor("mia", "USTEF")]);
    expect(most).toBe(1);
    expect(calls).toEqual(["signIn", "list", "list", "list"]);
  });

  it("DROPS-GENTLE a login the site has refused is not tried again, look after look, until the person reconnects", async () => {
    const store = memoryDropStore();
    let signIns = 0;
    const site = {
      signIn: async () => (signIns++, signIns === 1 ? ({ ok: true, session: { accessToken: "a", refreshToken: "r", expiresAt: 0 } } as const) : ({ ok: false, needsPerson: true, why: "Incorrect username or password." } as const)),
      renew: async () => ({ ok: false, expired: true, why: "expired" }) as const,
      list: async () => ({ ok: true, campaigns: [] }) as const,
    };
    const w = dropWatcher({ store, site, now: () => Date.parse("2026-09-20T13:00:00Z") });
    await w.connect("mia", "USTEF", "test+stef@tonoman.com", "pw-not-real");
    for (let i = 0; i < 6; i++) await w.lookFor("mia", "USTEF");
    expect(signIns).toBe(2); // the connect, and the one refusal — then it stops knocking
  });
});

describe("the drop watcher's output channel", () => {
  it("DROPS-IN-A-CHANNEL its settings offer an output channel, chosen like a recap's — in the catalogue's manifest and the Talent's own alike", () => {
    for (const m of [dropWatch, talentManifest]) {
      expect(m.configSchema?.find((f) => f.key === "output_channel")).toMatchObject({ type: "channel" });
    }
  });

  it("DROPS-IN-A-CHANNEL the channel a grant names is what is used; a grant that names none has none, and tells each person privately", () => {
    expect(dropChannel("C0DROPS")).toBe("C0DROPS");
    expect(dropChannel("  C0DROPS  ")).toBe("C0DROPS");
    for (const none of [undefined, null, "", "   ", 42, {}]) expect(dropChannel(none)).toBeUndefined();
  });
});
