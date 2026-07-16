// Contract tests for the MS Teams connector (channel-teams). All free: fetch is faked,
// the clock is injected, no socket is bound and no token is spent. Covers teams-inbound,
// -allowlist, -conversation-reference, -outbound-token, -reply-send, -stream-progressive,
// -stream-fallback, -typing, -media-inbound, -delivery-resilient, -inbound-auth.

import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { TeamsConnector, createBotFrameworkJwtValidator, stripMentions, resolveAttachment, sniffExtension, type TeamsActivity } from "./teams";
import { parseRoster } from "../identity";

/** A recording fake fetch driven by a route table (matched by URL substring). */
function makeFetch(routes: { match: string; respond: (init?: RequestInit) => Response | Promise<Response> }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    for (const r of routes) if (String(url).includes(r.match)) return r.respond(init);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const TOKEN = { match: "oauth2/v2.0/token", respond: () => new Response(JSON.stringify({ access_token: "bot-tok", expires_in: 3600 })) };
const ACTIVITIES = { match: "/activities", respond: () => new Response(JSON.stringify({ id: "act-123" })) };
/** A fixed mystic verb so the status-trace text is deterministic in tests. */
const COGITATE = () => ({ ing: "Cogitating", ed: "Cogitated" });
/** Pulls the rendered text out of a status-trace activity body (an Adaptive Card RichTextBlock). */
function statusCardText(body: string): string | undefined {
  return JSON.parse(body)?.attachments?.[0]?.content?.body?.[0]?.inlines?.[0]?.text;
}

function personalActivity(over: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    text: "draft today's invoices",
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    channelId: "msteams",
    from: { id: "29:user", name: "Rod", aadObjectId: "aad-rod" },
    recipient: { id: "28:bot" },
    conversation: { id: "a:1conv", conversationType: "personal", tenantId: "tenant-1" },
    ...over,
  };
}

function conn(over: Partial<ConstructorParameters<typeof TeamsConnector>[0]> = {}, fetchImpl?: typeof fetch) {
  return new TeamsConnector({
    appId: "app-id",
    appPassword: "secret",
    tenantId: "tenant-1",
    fetchImpl,
    validateToken: async () => true,
    ...over,
  });
}

describe("TeamsConnector — inbound normalize (teams-inbound)", () => {
  it("turns a message activity into a neutral envelope", async () => {
    const c = conn();
    const env = await c.normalize(personalActivity());
    expect(env).not.toBeNull();
    expect(env!.channel).toBe("teams");
    expect(env!.conversation).toBe("a:1conv");
    expect(env!.text).toBe("draft today's invoices");
    expect(env!.user).toBe("Rod");
  });

  it("ignores non-message activities (typing/conversationUpdate)", async () => {
    const c = conn();
    expect(await c.normalize({ type: "typing", conversation: { id: "x" }, serviceUrl: "https://smba.trafficmanager.net/" })).toBeNull();
  });

  it("strips Teams @mention markup", () => {
    expect(stripMentions("<at>Billy CC</at> draft invoices")).toBe("draft invoices");
  });
});

describe("TeamsConnector — allow-list (teams-allowlist)", () => {
  it("drops a sender not on the allow-list, accepts one on it", async () => {
    const c = conn({ allowedUser: "aad-rod" });
    expect(await c.normalize(personalActivity({ from: { id: "29:x", aadObjectId: "aad-other" } }))).toBeNull();
    expect(await c.normalize(personalActivity())).not.toBeNull();
  });
});

describe("TeamsConnector — conversationReference + outbound (teams-conversation-reference, -reply-send)", () => {
  it("captures the ref and posts a reply to the captured serviceUrl with the tenant + bearer", async () => {
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({}, f);
    await c.normalize(personalActivity()); // captures the ref
    await c.reply("a:1conv").finalize("", "3 drafts ready");

    const post = calls.find((x) => x.url.includes("/activities"))!;
    expect(post.url).toBe("https://smba.trafficmanager.net/teams/v3/conversations/a%3A1conv/activities");
    const headers = post.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bot-tok");
    const body = JSON.parse(post.init!.body as string);
    expect(body.type).toBe("message");
    expect(body.textFormat).toBe("markdown");
    expect(body.channelData.tenant.id).toBe("tenant-1");
    // (finalize with no prior send opens no stream, so no streaminfo entity here — the
    // stream-close entity is asserted in the streaming test below.)
  });

  it("a reply for an unknown conversation is a no-op (nothing to address), not an error", async () => {
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({}, f);
    await c.reply("never-seen").finalize("", "hi"); // no ref captured
    expect(calls.some((x) => x.url.includes("/activities"))).toBe(false);
  });
});

describe("TeamsConnector — bot token mint + cache (teams-outbound-token)", () => {
  it("mints once and caches; refreshes after expiry", async () => {
    let t = 1_000_000;
    const { f, calls } = makeFetch([TOKEN]);
    const c = conn({ now: () => t }, f);
    await c.botToken();
    await c.botToken();
    expect(calls.filter((x) => x.url.includes("/token")).length).toBe(1); // cached
    t += 3600 * 1000; // advance past expiry (expires_in 3600 − 60s skew)
    await c.botToken();
    expect(calls.filter((x) => x.url.includes("/token")).length).toBe(2); // refreshed
  });
});

describe("TeamsConnector — streaminfo streaming (teams-stream-progressive, -stream-fallback)", () => {
  it("send/update/finalize emit streaming → streaming(seq++) → final with the captured streamId", async () => {
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({}, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    expect(reply.canEdit()).toBe(true); // personal ⇒ streaming

    const id = await reply.send("3 drafts");
    expect(id).toBe("act-123");
    await reply.update(id, "3 drafts ready");
    await reply.finalize(id, "3 drafts ready, $4,200");

    const posts = calls.filter((x) => x.url.includes("/activities")).map((x) => JSON.parse(x.init!.body as string));
    expect(posts[0]).toMatchObject({ type: "typing", entities: [{ streamType: "streaming", streamSequence: 1 }] });
    expect(posts[1]).toMatchObject({ type: "typing", entities: [{ streamType: "streaming", streamId: "act-123", streamSequence: 2 }] });
    expect(posts[2]).toMatchObject({ type: "message", entities: [{ streamType: "final", streamId: "act-123" }] });
  });

  it("canEdit()=false for a group/channel conversation (block-send fallback)", async () => {
    const c = conn();
    await c.normalize(personalActivity({ conversation: { id: "g:1", conversationType: "groupChat", tenantId: "t" } }));
    expect(c.reply("g:1").canEdit()).toBe(false);
  });

  it("finalize self-heals: if the streaminfo-final POST is rejected, it falls back to a plain message", async () => {
    const posts: { body: Record<string, unknown> }[] = [];
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "bot-tok", expires_in: 3600 }));
      const body = JSON.parse(init!.body as string);
      posts.push({ body });
      // Reject any activity carrying a streaminfo entity (simulate a protocol mismatch).
      if (Array.isArray(body.entities) && body.entities.some((e: { type?: string }) => e.type === "streaminfo")) {
        return new Response("bad", { status: 400 });
      }
      return new Response(JSON.stringify({ id: "ok" }));
    }) as unknown as typeof fetch;
    const c = conn({}, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.send("partial").catch(() => {}); // streaming chunk 400s (entities) — opens but the post fails
    await reply.finalize("", "the full answer"); // must NOT throw — falls back to a plain message

    const plain = posts.find((p) => p.body.type === "message" && !p.body.entities);
    expect(plain).toBeDefined(); // the answer landed as a plain message despite the streaminfo rejection
    expect(plain!.body.text).toBe("the full answer");
  });

  it("card cue is suppressed once text has started (no informative interleaved with streaming chunks)", async () => {
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({ workingCue: "card" }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // before text → informative cue fires
    await reply.send("hi"); // first text chunk → textStarted
    await reply.working(); // after text → suppressed
    const informative = calls.filter((x) => x.url.includes("/activities") && (JSON.parse(x.init!.body as string).entities ?? []).some((e: { streamType?: string }) => e.streamType === "informative"));
    expect(informative.length).toBe(1); // only the pre-text informative cue
  });

  it("past the age cap, streaming STOPS with NO partial posted — finalize delivers ONE message (teams-stream-keepalive)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({ now: () => t, maxStreamAgeMs: 100 }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.send("a"); // opens the stream (typing+streaming seq1)
    t = 500; // past the 100ms cap
    await reply.update("act-123", "ab"); // crossing the cap: stop streaming — must NOT post a partial
    await reply.finalize("act-123", "ab, the full answer");

    const posts = calls.filter((x) => x.url.endsWith("/activities")).map((x) => ({ m: x.init?.method, b: JSON.parse(x.init!.body as string) }));
    // Crucially: no streaminfo-`final` PARTIAL was ever posted (that split answers into partial + full).
    const partialFinals = posts.filter((p) => p.m !== "PUT" && p.b.type === "message" && p.b.entities?.[0]?.streamType === "final" && p.b.text === "ab");
    expect(partialFinals.length).toBe(0);
    // The answer lands EXACTLY once — the finalize streaminfo-final carrying the full text.
    const finals = posts.filter((p) => p.b.type === "message" && p.b.entities?.[0]?.streamType === "final");
    expect(finals.length).toBe(1);
    expect(finals[0].b.text).toBe("ab, the full answer");
    // and no PUT edit (grow-in-place is gone — it never worked)
    expect(posts.some((p) => p.m === "PUT")).toBe(false);
  });

  it("finalize past the cap falls back to a plain message if the streaminfo-final is rejected — still ONE message (teams-stream-keepalive)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([
      TOKEN,
      {
        match: "/activities",
        respond: (init) => {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          // Teams rejects a stream-close past its limit (ContentStreamNotAllowed) → the connector must
          // fall back to a plain message. Reject any streaminfo-final; accept everything else.
          if (body?.entities?.[0]?.streamType === "final") return new Response(JSON.stringify({ error: { code: "ContentStreamNotAllowed" } }), { status: 403 });
          return new Response(JSON.stringify({ id: "act-123" }));
        },
      },
    ]);
    const c = conn({ now: () => t, maxStreamAgeMs: 100 }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.send("a");
    t = 500;
    await reply.update("act-123", "ab"); // cap → stop streaming
    await reply.finalize("act-123", "the full answer"); // streaminfo-final 403s → must NOT throw, plain fallback

    const plain = calls
      .filter((x) => x.url.endsWith("/activities") && x.init?.method === "POST")
      .map((x) => JSON.parse(x.init!.body as string))
      .filter((b) => b.type === "message" && b.text === "the full answer" && !b.entities);
    expect(plain.length).toBe(1); // the answer still lands, exactly once, as a plain message
  });

  it("further update()s after the cap no-op streaming but keep the latest prefix for finalize (teams-stream-keepalive)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({ now: () => t, maxStreamAgeMs: 100 }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.send("a");
    t = 500;
    await reply.update("act-123", "ab"); // cap → stop streaming (no post)
    await reply.update("act-123", "abc"); // AFTER the cap — must NOT stream again
    await reply.update("act-123", "abcd");
    await reply.finalize("act-123", "abcd done");

    const streamingPosts = calls
      .filter((x) => x.url.endsWith("/activities") && x.init?.method !== "PUT")
      .map((x) => JSON.parse(x.init!.body as string))
      .filter((b) => b.type === "typing" && b.entities?.[0]?.streamType === "streaming");
    expect(streamingPosts.length).toBe(1); // exactly the one live chunk (send); nothing streamed past the cap
    const finals = calls
      .filter((x) => x.url.endsWith("/activities"))
      .map((x) => JSON.parse(x.init!.body as string))
      .filter((b) => b.entities?.[0]?.streamType === "final");
    expect(finals.length).toBe(1); // one finalize, carrying the freshest prefix's full answer
    expect(finals[0].text).toBe("abcd done");
  });

  it("heartbeat re-emits a streaming keepalive during a post-text idle gap (teams-stream-keepalive)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({ now: () => t, maxStreamAgeMs: 100_000 }, f); // big cap: exercise keepalive, not the cap
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.send("hello"); // opens stream at t=0, lastStreamAt=0
    t = 5_000; // a 5s idle gap while a tool runs — NO update() in this window
    await reply.working("🔧 Bash: pup logs search"); // the 4s heartbeat tick

    const streams = calls
      .filter((x) => x.url.endsWith("/activities") && x.init?.method !== "PUT")
      .map((x) => JSON.parse(x.init!.body as string))
      .filter((b) => b.type === "typing" && b.entities?.[0]?.streamType === "streaming");
    expect(streams.length).toBe(2); // the send + a heartbeat keepalive (previously: nothing → indicator died)
    expect(streams[1].text).toBe("hello"); // keepalive re-emits the last streamed prefix
    expect(streams[1].entities[0].streamSequence).toBeGreaterThan(streams[0].entities[0].streamSequence ?? 0);
  });

  it("past the cap, the heartbeat stops streaming and keeps a plain typing bubble alive — no partial (teams-stream-keepalive)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({ now: () => t, maxStreamAgeMs: 100 }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.send("partial"); // opens stream at t=0
    t = 5_000; // past the cap, update() NEVER called (deep in a tool)
    await reply.working("🔧 Bash: slow query"); // heartbeat crosses the cap → stop streaming (no post)
    const mark = calls.length;
    t = 9_000;
    await reply.working(); // next heartbeat, now capped → plain "…" bubble, NOT a streaming activity

    // No streaminfo-`final` PARTIAL was ever posted by the heartbeat (the split-message bug).
    const allPosts = calls.filter((x) => x.url.endsWith("/activities") && x.init?.method !== "PUT").map((x) => JSON.parse(x.init!.body as string));
    expect(allPosts.some((b) => b.type === "message" && b.entities?.[0]?.streamType === "final")).toBe(false);
    // After the cap, liveness rides a plain typing bubble; no more streaming activities.
    const after = calls.slice(mark).filter((x) => x.url.endsWith("/activities")).map((x) => JSON.parse(x.init!.body as string));
    expect(after.some((b) => b.type === "typing" && !b.entities)).toBe(true); // plain bubble keeps liveness
    expect(after.some((b) => b.entities?.[0]?.streamType === "streaming")).toBe(false); // no streaming post-cap
  });

  it("status elapsed counts exact seconds in the first minute, 10s steps after (teams-working-status)", async () => {
    // pure formatter checks via the status trace text
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "status-x" })) }]);
    const c = conn({ now: () => t, pickVerb: COGITATE }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // t=0 sets workingStart; status delayed
    const texts: string[] = [];
    for (const at of [5_000, 12_000, 47_000, 70_000, 130_000]) {
      t = at;
      await reply.working();
    }
    for (const x of calls.filter((x) => x.url.includes("/activities"))) {
      const s = statusCardText(x.init!.body as string);
      if (s) texts.push(s);
    }
    expect(texts).toContain("🤖 Cogitating… 5s"); // exact seconds early — clearly moving
    expect(texts).toContain("🤖 Cogitating… 47s");
    expect(texts).toContain("🤖 Cogitating… 1m10s"); // 10s steps after a minute
    expect(texts).toContain("🤖 Cogitating… 2m10s");
  });
});

describe("TeamsConnector — typing + media (teams-typing, teams-media-inbound)", () => {
  it("working() (default 'message' cue): typing bubble, a delayed gray-italic status trace, updated then SETTLED (not deleted) at finalize", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "status-1" })) }]);
    const c = conn({ now: () => t, pickVerb: COGITATE }, f); // default cue = "message"
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // t=0 → typing bubble only (status delayed)
    t = 4_000;
    await reply.working(); // past delay → CREATE status trace "Cogitating… 4s"
    t = 12_000;
    await reply.working(); // exact-seconds step → UPDATE (PUT) trace to "Cogitating… 12s"
    await reply.finalize("", "Done — 3 drafts ready");

    const acts = calls.filter((x) => x.url.includes("/activities"));
    // (1) typing bubble present (plain typing, no streaminfo, no text).
    expect(acts.some((x) => x.init!.method === "POST" && (() => { const b = JSON.parse(x.init!.body as string); return b.type === "typing" && !b.entities && !b.text; })())).toBe(true);
    // (2) status trace: created (POST card), updated (PUT card), then SETTLED in place (final PUT) — never deleted.
    const statusPost = acts.find((x) => x.init!.method === "POST" && statusCardText(x.init!.body as string) === "🤖 Cogitating… 4s");
    expect(statusPost).toBeDefined();
    const putTexts = acts.filter((x) => x.init!.method === "PUT").map((x) => statusCardText(x.init!.body as string));
    expect(putTexts).toContain("🤖 Cogitating… 12s"); // exact-seconds step update (🤖 marker while in progress)
    expect(putTexts).toContain("Cogitated for 12 seconds"); // settled to a final past-tense footer
    expect(acts.some((x) => x.init!.method === "DELETE")).toBe(false); // never deleted (no "deleted" quirk)
    // and the actual reply landed.
    expect(acts.some((x) => x.init!.method === "POST" && JSON.parse(x.init!.body as string).text === "Done — 3 drafts ready")).toBe(true);
  });

  it("settle() resolves the in-progress status even WITHOUT finalize (error/abort paths), idempotently", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "status-1" })) }]);
    const c = conn({ now: () => t, pickVerb: COGITATE }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // t=0 → typing only
    t = 5_000;
    await reply.working(); // → CREATE "🤖 Cogitating…" trace
    t = 12_000;
    await reply.settle!(); // NO finalize (the error/abort path) — must still resolve the cue
    await reply.settle!(); // idempotent — a second settle is a no-op

    const settles = calls
      .filter((x) => x.url.includes("/activities") && x.init!.method === "PUT")
      .map((x) => statusCardText(x.init!.body as string))
      .filter((s) => s?.startsWith("Cogitated for"));
    expect(settles).toEqual(["Cogitated for 12 seconds"]); // resolved once to past-tense, never left "…ing"
  });

  it("concurrent working() calls create EXACTLY ONE status trace (no dangling double-post)", async () => {
    // The router fires working() from a ~4s heartbeat AND from each tool event — often within the
    // same tick, before the first postActivity resolves. Without serialization both see
    // statusMsgId==="" and POST, orphaning the first as a dangling "…ing…". opChain must collapse
    // them to one POST.
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "status-1" })) }]);
    const c = conn({ now: () => t, pickVerb: COGITATE }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    // Fire three concurrently (tool label bypasses the delay so each WOULD create a trace).
    await Promise.all([reply.working("🔧 Bash: a"), reply.working("🔧 Bash: a"), reply.working("🔧 Bash: a")]);
    const statusPosts = calls.filter(
      (x) => x.url.includes("/activities") && x.init!.method === "POST" && statusCardText(x.init!.body as string) !== undefined,
    );
    expect(statusPosts).toHaveLength(1);
    // and a settle after them resolves that single trace (still no dangling cue).
    t = 8_000;
    await reply.settle!();
    const settled = calls.filter((x) => x.init!.method === "PUT").map((x) => statusCardText(x.init!.body as string)).filter((s) => s?.startsWith("Cogitated for"));
    expect(settled).toEqual(["Cogitated for 8 seconds"]);
  });

  it("working(status): a concrete tool label shows immediately as the status trace (gw-tool-narration)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "status-1" })) }]);
    const c = conn({ now: () => t, pickVerb: COGITATE }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working("🔧 Bash: rn wiki sync"); // t=0 → shows NOW (real work happening), not after the 4s delay
    const acts = calls.filter((x) => x.url.includes("/activities"));
    // the tool label is posted as the status trace (overriding the generic mystic-verb cue)
    expect(acts.some((x) => x.init!.method === "POST" && (statusCardText(x.init!.body as string) ?? "").includes("🔧 Bash: rn wiki sync"))).toBe(true);
  });

  it("'message' cue: a quick reply (under the delay) never creates a status message", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({ now: () => t }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // t=0 → bubble only
    t = 1_500; // reply arrives fast, before the status delay
    await reply.send("Quick answer");
    await reply.finalize("", "Quick answer");
    const acts = calls.filter((x) => x.url.includes("/activities"));
    expect(acts.some((x) => x.init!.method === "PUT" || x.init!.method === "DELETE")).toBe(false); // no status lifecycle
    expect(acts.some((x) => statusCardText(x.init!.body as string) !== undefined)).toBe(false); // no status trace created at all
  });

  it("'message' cue: the status keeps updating MID-TURN after text has started (the quiet-gap fix), then SETTLES to a final trace (never deleted)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "status-9" })) }]);
    const c = conn({ now: () => t, pickVerb: COGITATE }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // t=0 → sets workingStart (mimics keepWorking's immediate tick); status delayed
    t = 4_000;
    await reply.working(); // past delay → create status (pre-text, so it sits ABOVE the answer)
    await reply.send("Let me pull that…"); // text starts (mid-turn begins)
    t = 65_000;
    await reply.working(); // MID-TURN update → PUT status to "Cogitating… 1m"
    await reply.finalize("", "Here it is.");

    const acts = calls.filter((x) => x.url.includes("/activities"));
    const puts = acts.filter((x) => x.init!.method === "PUT").map((x) => statusCardText(x.init!.body as string));
    expect(puts).toContain("🤖 Cogitating… 1m"); // updated AFTER text started — the mid-turn quiet-gap cue
    expect(puts).toContain("Cogitated for 1 minute"); // settled to a final past-tense footer (clean, no 🤖)
    expect(acts.some((x) => x.init!.method === "DELETE")).toBe(false); // never deleted (no "deleted" quirk)
  });

  it("'message' cue: never creates a status trace BELOW an in-flight answer (text started before the delay → no trace)", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({ now: () => t, pickVerb: COGITATE }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // t=0 → bubble only
    t = 2_000;
    await reply.send("streaming already…"); // text starts before the 4s status delay
    t = 30_000;
    await reply.working(); // would be mid-turn, but no pre-text trace exists → must NOT create one below the answer
    await reply.finalize("", "the answer");
    const acts = calls.filter((x) => x.url.includes("/activities"));
    expect(acts.some((x) => statusCardText(x.init!.body as string) !== undefined)).toBe(false); // no orphan footer under the answer
  });

  it("'card' cue (config-gated): typing bubble + informative streaminfo that steps 10s→minute, deduped, first text CONTINUES the stream; fail-soft", async () => {
    let t = 0;
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "stream-7" })) }]);
    const c = conn({ now: () => t, workingCue: "card" }, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.working(); // t=0 → bubble + informative "🤖 working…" (seq1), captures streamId
    t = 5_000;
    await reply.working(); // "🤖 working… (5s)" — exact seconds now, no longer deduped (seq2)
    t = 12_000;
    await reply.working(); // "🤖 working… (12s)" (seq3)
    t = 65_000;
    await reply.working(); // "🤖 working… (1m)" (seq4)
    const id = await reply.send("Here's the answer"); // first text → CONTINUES stream (seq5)

    const posts = calls.filter((x) => x.url.includes("/activities")).map((x) => JSON.parse(x.init!.body as string));
    expect(posts.some((p) => p.type === "typing" && !p.entities && !p.text)).toBe(true); // bubble
    const infos = posts.filter((p) => (p.entities ?? []).some((e: { streamType?: string }) => e.streamType === "informative"));
    expect(infos.map((p) => p.text)).toEqual(["🤖 working…", "🤖 working… (5s)", "🤖 working… (12s)", "🤖 working… (1m)"]);
    expect(id).toBe("stream-7");
    const chunk = posts.find((p) => (p.entities ?? []).some((e: { streamType?: string }) => e.streamType === "streaming"))!;
    expect(chunk.entities[0]).toMatchObject({ streamType: "streaming", streamId: "stream-7", streamSequence: 5 });

    // a throwing transport must not propagate out of working()
    const boom = (() => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const c2 = conn({ workingCue: "card" }, boom);
    await c2.normalize(personalActivity());
    await expect(c2.reply("a:1conv").working()).resolves.toBeUndefined();
  });

  it("working() in a GROUP chat posts a plain typing activity (no streaminfo)", async () => {
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({}, f);
    await c.normalize(personalActivity({ conversation: { id: "g:1", conversationType: "groupChat", tenantId: "t" } }));
    await c.reply("g:1").working();
    const body = JSON.parse(calls.find((x) => x.url.includes("/activities"))!.init!.body as string);
    expect(body.type).toBe("typing");
    expect(body.entities).toBeUndefined(); // no streaminfo in a group
  });

  it("downloads an inline image on a Bot Framework host WITH the bot bearer (teams-media-inbound)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnteams-"));
    let authSeen: string | undefined;
    const { f } = makeFetch([
      TOKEN,
      {
        match: "smba.trafficmanager.net/amer/img",
        respond: (init) => {
          authSeen = (init?.headers as Record<string, string>)?.Authorization;
          return new Response(Buffer.from([1, 2, 3]));
        },
      },
    ]);
    const c = conn({ mediaDir: dir, mediaMount: "/root/media" }, f);
    const env = await c.normalize(
      personalActivity({ attachments: [{ contentType: "image/png", contentUrl: "https://smba.trafficmanager.net/amer/img/1", name: "shot.png" }] }),
    );
    expect(env!.mediaPaths.length).toBe(1);
    expect(env!.mediaPaths[0].startsWith("/root/media/")).toBe(true);
    expect(authSeen).toBe("Bearer bot-tok"); // BF image → bot token
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("names the on-disk file by its MAGIC BYTES, not a bogus name/host ext (a JPEG saved as .net)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnteams-"));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); // JPEG magic
    const { f } = makeFetch([TOKEN, { match: "smba.trafficmanager.net/amer/img", respond: () => new Response(jpeg) }]);
    const c = conn({ mediaDir: dir, mediaMount: "/root/media" }, f);
    // Teams sends NO name for this inline image → the old code produced "attachment-…net".
    const env = await c.normalize(
      personalActivity({ attachments: [{ contentType: "image/png", contentUrl: "https://smba.trafficmanager.net/amer/img/1" }] }),
    );
    expect(env!.mediaPaths[0].endsWith(".jpg")).toBe(true); // sniffed JPEG, not ".net"/".png"
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("downloads a file.download.info attachment (a receipt) from content.downloadUrl WITHOUT auth", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnteams-"));
    let sawAuthHeader = true;
    const { f } = makeFetch([
      TOKEN,
      {
        match: "sharepoint.example/download",
        respond: (init) => {
          sawAuthHeader = "Authorization" in ((init?.headers as Record<string, string>) ?? {});
          return new Response(Buffer.from([9, 9, 9]));
        },
      },
    ]);
    const c = conn({ mediaDir: dir, mediaMount: "/root/media" }, f);
    const env = await c.normalize(
      personalActivity({
        text: "here's my receipt",
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            name: "receipt.pdf",
            contentUrl: "https://sharepoint.example/sites/x/receipt.pdf", // a landing page, NOT the bytes
            content: { downloadUrl: "https://sharepoint.example/download/abc", fileType: "pdf" },
          },
        ],
      }),
    );
    expect(env!.mediaPaths.length).toBe(1);
    expect(env!.mediaPaths[0].startsWith("/root/media/")).toBe(true);
    expect(env!.mediaPaths[0].endsWith(".pdf")).toBe(true); // filename/ext preserved
    expect(sawAuthHeader).toBe(false); // pre-authed downloadUrl → NO bot token
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("resolveAttachment — shape → {url, name, auth} (teams-media-inbound)", () => {
  it("file.download.info → content.downloadUrl, no auth, filename from name", () => {
    const d = resolveAttachment({
      contentType: "application/vnd.microsoft.teams.file.download.info",
      name: "receipt.pdf",
      content: { downloadUrl: "https://sp/dl", fileType: "pdf" },
    });
    expect(d).toEqual({ url: "https://sp/dl", name: "receipt.pdf", auth: false });
  });

  it("file.download.info with no downloadUrl → null (nothing to fetch)", () => {
    expect(resolveAttachment({ contentType: "application/vnd.microsoft.teams.file.download.info", content: {} })).toBeNull();
  });

  it("image/* on a Bot Framework host → contentUrl WITH auth", () => {
    const d = resolveAttachment({ contentType: "image/png", contentUrl: "https://smba.trafficmanager.net/x/1", name: "a.png" });
    expect(d).toMatchObject({ url: "https://smba.trafficmanager.net/x/1", auth: true });
  });

  it("image/* on a NON-allowlisted host → no auth (never leak the token)", () => {
    const d = resolveAttachment({ contentType: "image/png", contentUrl: "https://evil.example/x/1", name: "a.png" });
    expect(d).toMatchObject({ auth: false });
  });

  it("an inline image with no name → a synthetic filename whose ext comes from the contentType", () => {
    // regression: a JPEG once saved as ".net" (ext from the host) so Read couldn't tell it was an image.
    const d = resolveAttachment({ contentType: "image/jpeg", contentUrl: "https://smba.trafficmanager.net/x/1" });
    expect(d!.name.endsWith(".jpg")).toBe(true);
    expect(d!.name.endsWith(".net")).toBe(false);
  });

  it("a card attachment → null", () => {
    expect(resolveAttachment({ contentType: "application/vnd.microsoft.card.adaptive" })).toBeNull();
  });
});

describe("sniffExtension — magic-byte file typing", () => {
  it("recognizes common receipt/image formats and rejects unknown", () => {
    expect(sniffExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(".jpg");
    expect(sniffExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(".png");
    expect(sniffExtension(Buffer.from("GIF89a"))).toBe(".gif");
    expect(sniffExtension(Buffer.from("%PDF-1.7"))).toBe(".pdf");
    expect(sniffExtension(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]))).toBe(".webp");
    expect(sniffExtension(Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("ftypheic")]))).toBe(".heic");
    expect(sniffExtension(Buffer.from("just some text"))).toBe(""); // unknown → caller falls back
  });
});

describe("TeamsConnector — standalone notice (teams-notice)", () => {
  it("note() posts a PLAIN message (no streaminfo), edits by id, and SETTLES on remove (no delete tombstone) — the queue-footer path", async () => {
    const { f, calls } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response(JSON.stringify({ id: "note-1" })) }]);
    const c = conn({}, f);
    await c.normalize(personalActivity());

    // post (one reply instance), edit by id (a DIFFERENT instance — the cross-call footer case), delete.
    const id = await c.reply("a:1conv").note!(undefined, '🗂 Queued (1): "draft today…"');
    expect(id).toBe("note-1");
    await c.reply("a:1conv").note!(id, "🗂 Queued (2): …");
    await c.reply("a:1conv").note!(id, null);

    const acts = calls.filter((x) => x.url.includes("/activities"));
    const post = acts.find((x) => x.init!.method === "POST")!;
    const body = JSON.parse(post.init!.body as string);
    expect(body.type).toBe("message");
    expect(body.entities).toBeUndefined(); // NOT a streaminfo stream — a plain, independently-editable bubble
    const puts = acts.filter((x) => x.init!.method === "PUT").map((x) => JSON.parse(x.init!.body as string).text);
    expect(puts).toContain("🗂 Queued (2): …"); // edit-by-id across reply instances
    expect(puts).toContain("🗂 Picked up your queued message."); // remove SETTLES in place (past-tense)
    expect(acts.some((x) => x.init!.method === "DELETE")).toBe(false); // never deletes → no "This message was deleted" tombstone
  });
});

describe("TeamsConnector — stream reset on self-heal retry (teams-stream-reset)", () => {
  it("reset() closes the open stream (streaminfo final) and the next send() starts a FRESH stream at seq 1", async () => {
    const { f, calls } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({}, f);
    await c.normalize(personalActivity());
    const reply = c.reply("a:1conv");
    await reply.send("partial from the failed attempt"); // opens stream #1 (seq 1)
    await reply.reset!(); // close + reset cursors
    await reply.send("answer from the retry"); // must open a NEW stream, not continue #1

    const streamTypes = calls
      .filter((x) => x.url.includes("/activities"))
      .map((x) => {
        try {
          return (JSON.parse(x.init!.body as string).entities ?? [])[0]?.streamType as string | undefined;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    // streaming (attempt) → final (reset closes it) → streaming (retry) — a fresh stream, no 403 continuation
    expect(streamTypes).toEqual(["streaming", "final", "streaming"]);
  });
});

describe("TeamsConnector — delivery resilience (teams-delivery-resilient)", () => {
  it("retries a transient transport blip then succeeds", async () => {
    let n = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "bot-tok", expires_in: 3600 }));
      n++;
      if (n === 1) throw new TypeError("fetch failed"); // transient
      return new Response(JSON.stringify({ id: "act-9" }));
    }) as unknown as typeof fetch;
    const c = conn({}, f);
    await c.normalize(personalActivity());
    const id = await c.reply("a:1conv").send("hi");
    expect(id).toBe("act-9");
    expect(n).toBe(2); // one retry
  });

  it("a non-retryable HTTP error throws (the consumer turns it into a non-fatal miss)", async () => {
    const { f } = makeFetch([TOKEN, { match: "/activities", respond: () => new Response("bad", { status: 400 }) }]);
    const c = conn({}, f);
    await c.normalize(personalActivity());
    await expect(c.reply("a:1conv").send("hi")).rejects.toThrow();
  });

  it("a failed bot-token mint is logged LOUDLY with an actionable cause (never a silent no-reply)", async () => {
    const f = (async (url: unknown) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000229: The client application is missing service principal in the tenant. See..." }), { status: 401 });
      }
      return new Response(JSON.stringify({ id: "x" }));
    }) as unknown as typeof fetch;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = conn({}, f);
      await c.normalize(personalActivity());
      await expect(c.reply("a:1conv").finalize("", "answer")).rejects.toThrow(/token mint failed/);
      const logged = spy.mock.calls.map((a) => a.join(" ")).join("\n");
      expect(logged).toMatch(/BOT TOKEN MINT FAILED/);
      expect(logged).toMatch(/service principal|AADSTS7000229/);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to send a bearer to a serviceUrl whose host is not allow-listed (SSRF guard)", async () => {
    const { f } = makeFetch([TOKEN, ACTIVITIES]);
    const c = conn({}, f);
    await c.normalize(personalActivity({ serviceUrl: "https://evil.example/" }));
    await expect(c.reply("a:1conv").finalize("", "x")).rejects.toThrow(/host not allowed/);
  });
});

// --- inbound JWT validation (teams-inbound-auth) -----------------------------

function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signJwt(payload: object, privateKey: crypto.KeyObject, kid: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${body}`).end().sign(privateKey);
  return `${header}.${body}.${b64url(sig)}`;
}

describe("createBotFrameworkJwtValidator (teams-inbound-auth)", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" };
  const jwksFetch = (async (url: unknown) => {
    if (String(url).includes("jwks")) return new Response(JSON.stringify({ keys: [jwk] }));
    return new Response("{}");
  }) as unknown as typeof fetch;
  const now = () => 1_700_000_000_000;
  const mk = () => createBotFrameworkJwtValidator({ appId: "app-id", fetchImpl: jwksFetch, now, jwksUri: "https://jwks" });
  const sec = Math.floor(now() / 1000);

  const ISS = "https://api.botframework.com";

  it("accepts a correctly signed token with the right audience + issuer", async () => {
    const tok = signJwt({ aud: "app-id", iss: ISS, exp: sec + 600, nbf: sec - 10 }, privateKey, "k1");
    expect(await mk()(`Bearer ${tok}`)).toBe(true);
  });

  it("rejects wrong audience, wrong issuer, expired, tampered signature, and missing header", async () => {
    const wrongAud = signJwt({ aud: "someone-else", iss: ISS, exp: sec + 600 }, privateKey, "k1");
    const wrongIss = signJwt({ aud: "app-id", iss: "https://evil.example", exp: sec + 600 }, privateKey, "k1");
    const expired = signJwt({ aud: "app-id", iss: ISS, exp: sec - 60 }, privateKey, "k1");
    const good = signJwt({ aud: "app-id", iss: ISS, exp: sec + 600 }, privateKey, "k1");
    const tampered = good.slice(0, -4) + "AAAA";
    const v = mk();
    expect(await v(`Bearer ${wrongAud}`)).toBe(false);
    expect(await v(`Bearer ${wrongIss}`)).toBe(false);
    expect(await v(`Bearer ${expired}`)).toBe(false);
    expect(await v(`Bearer ${tampered}`)).toBe(false);
    expect(await v(undefined)).toBe(false);
  });
});

describe("TeamsConnector — email-verified identity (identity-roster)", () => {
  const roster = parseRoster(
    JSON.stringify({
      people: [
        { name: "Priya Raman", role: "the approver", emails: ["priya@northgate.example"] },
        { name: "Rod", role: "operator", emails: ["rod@example.com"] },
        { name: "Rod2", role: "operator (second identity)", emails: ["rod2@example.com"] },
      ],
    }),
  );
  const MEMBER = (email: string) => ({ match: "/members/", respond: () => new Response(JSON.stringify({ email })) });

  it("identity-email-resolve + identity-roster-match: resolves the sender email and verifies against the roster", async () => {
    const { f } = makeFetch([TOKEN, MEMBER("priya@northgate.example")]);
    const env = await conn({ roster }, f).normalize(personalActivity({ from: { id: "29:s", name: "Display Spoof" } }));
    expect(env?.identity).toMatchObject({ name: "Priya Raman", role: "the approver", email: "priya@northgate.example", verified: true });
  });

  it("identity-roster-distinct: two different emails resolve to two DIFFERENT people", async () => {
    const a = await conn({ roster }, makeFetch([TOKEN, MEMBER("rod@example.com")]).f).normalize(personalActivity({ from: { id: "29:a" } }));
    const b = await conn({ roster }, makeFetch([TOKEN, MEMBER("rod2@example.com")]).f).normalize(personalActivity({ from: { id: "29:b" } }));
    expect(a?.identity?.name).toBe("Rod");
    expect(b?.identity?.name).toBe("Rod2");
  });

  it("identity-roster-unknown: an unlisted email is unverified (no role), turn still runs", async () => {
    const { f } = makeFetch([TOKEN, MEMBER("stranger@example.com")]);
    const env = await conn({ roster }, f).normalize(personalActivity({ from: { id: "29:x", name: "Priya Raman" } }));
    expect(env).not.toBeNull(); // restrict OFF → still delivered
    expect(env?.identity).toMatchObject({ verified: false });
    expect(env?.identity?.role).toBeUndefined();
  });

  it("identity-roster-restrict: an unlisted email is refused with a deterministic notice, no turn", async () => {
    const { f, calls } = makeFetch([TOKEN, MEMBER("stranger@example.com"), ACTIVITIES]);
    const env = await conn({ roster, restrictToRoster: true }, f).normalize(personalActivity({ from: { id: "29:x" } }));
    expect(env).toBeNull(); // dropped — no turn
    const posted = calls.find((c) => c.url.includes("/activities") && c.init?.method === "POST");
    expect(String(posted?.init?.body)).toContain("not authorized");
    expect(String(posted?.init?.body)).toContain("stranger@example.com");
  });

  it("identity-email-cached: the members API is hit once per sender within the TTL", async () => {
    const { f, calls } = makeFetch([TOKEN, MEMBER("priya@northgate.example")]);
    const c = conn({ roster }, f);
    await c.normalize(personalActivity({ from: { id: "29:same" } }));
    await c.normalize(personalActivity({ from: { id: "29:same" } }));
    expect(calls.filter((x) => x.url.includes("/members/")).length).toBe(1);
  });

  it("identity-email-nonfatal: a members lookup failure degrades to unverified, turn still runs", async () => {
    const FAIL = { match: "/members/", respond: () => new Response("nope", { status: 500 }) };
    const { f } = makeFetch([TOKEN, FAIL]);
    const env = await conn({ roster }, f).normalize(personalActivity());
    expect(env).not.toBeNull();
    expect(env?.identity?.verified).toBe(false);
  });

  it("no roster configured → no members lookup at all (unchanged legacy behavior)", async () => {
    const { f, calls } = makeFetch([TOKEN]);
    const env = await conn({}, f).normalize(personalActivity());
    expect(calls.some((c) => c.url.includes("/members/"))).toBe(false);
    expect(env?.identity?.verified).toBe(false);
  });
});
