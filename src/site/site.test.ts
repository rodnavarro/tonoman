// `tonoman site`, through the broker a turn talks to, against a stand-in for a site's content API
// (FIX-SITE): pages with a draft and a published version per language, the sections it offers, and
// the refusals a real site makes. Rule names start each test title (website.md in Tonoman Cloud).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore } from "../brains/store";
import { createBroker, type Broker, type Reach } from "../brains/broker";
import { siteOf } from "../worker/activities";
import { normPath, occurrences, sectionProblem, tidy } from "./commands";
import type { SiteShape } from "./payload";

const KEY = "key-for-the-agent";
const SECRET = "preview-secret";
const SITE = "https://site.test";
const OWNER = "UOWNER", MEMBER = "UMEMBER", STRANGER = "USTRANGER";

const SHAPE: SiteShape = {
  languages: ["en", "es"],
  sections: [
    { blockType: "hero", label: "Hero", fields: [{ name: "variant", type: "select", options: ["centered", "home"] }, { name: "eyebrow", type: "text" }, { name: "title", type: "text", required: true }, { name: "sub", type: "textarea" }] },
    { blockType: "text", label: "Text", fields: [{ name: "heading", type: "text" }, { name: "body", type: "textarea", required: true }] },
    { blockType: "faq", label: "FAQ", fields: [{ name: "heading", type: "text" }, { name: "items", type: "array", required: true, fields: [{ name: "question", type: "text", required: true }, { name: "answer", type: "textarea", required: true }] }] },
  ],
};

type Content = { title?: string; path?: string; summary?: string; meta?: { description?: string; titleTag?: string }; layout?: Record<string, unknown>[] };
type Doc = { id: number; main: Record<string, Content>; mainStatus: "draft" | "published"; latest: Record<string, Content>; latestStatus: "draft" | "published" };

/** FIX-SITE: a site's content API, in this process. What visitors see is `main` while `mainStatus`
 *  is published; what a previewer sees is `latest`. */
function fakeSite() {
  const docs: Doc[] = [];
  let nextId = 1;
  const calls: string[] = [];
  /** What reached the site's image upload, as it arrived. */
  const uploads: { filename: string; alt: string; bytes: Buffer }[] = [];
  const json =(status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (message: string) => json(400, { errors: [{ message }] });
  const view = (d: Doc, lang: string, draft: boolean) => {
    const c = (draft ? d.latest : d.main)[lang] ?? {};
    return { id: d.id, ...c, path: c.path ?? null, _status: draft ? d.latestStatus : d.mainStatus, updatedAt: "2026-10-03T00:00:00.000Z" };
  };
  /** Like the real thing, a `select` returns the id and ONLY the fields it names. */
  const all = (d: Doc, draft: boolean, url: URL) => {
    const src = draft ? d.latest : d.main;
    const loc = (k: "title" | "path") => Object.fromEntries(Object.entries(src).map(([l, c]) => [l, c[k] ?? null]));
    const full: Record<string, unknown> = { title: loc("title"), path: loc("path"), _status: draft ? d.latestStatus : d.mainStatus };
    const picked = [...url.searchParams.keys()].filter((k) => k.startsWith("select[")).map((k) => k.slice(7, -1));
    return { id: d.id, ...(picked.length ? Object.fromEntries(picked.map((k) => [k, full[k]])) : full) };
  };
  const pathProblem = (p: string | undefined, lang: string, id?: number): string | null => {
    if (!p) return "A page needs an address, like /newsletter.";
    if (p.startsWith("/admin")) return `${p} is kept for the site itself.`;
    if (lang === "es" && !p.startsWith("/es/") && p !== "/es") return "A Spanish address starts with /es/ — for example /es/boletin.";
    if (docs.some((d) => d.id !== id && (d.latest[lang]?.path === p || d.main[lang]?.path === p))) return `Another page already lives at ${p}.`;
    return null;
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    if ((init?.headers as Record<string, string> | undefined)?.authorization !== `users API-Key ${KEY}`) return json(401, { errors: [{ message: "You are not allowed to perform this action." }] });
    const lang = url.searchParams.get("locale") ?? "en";
    const draft = url.searchParams.get("draft") === "true";
    const body = init?.body ? (JSON.parse(String(init.body)) as Content & { _status?: string }) : {};
    if (url.pathname === "/cms-api/media/upload" && method === "POST") {
      const sent = body as { filename?: string; alt?: string; data?: string };
      uploads.push({ filename: sent.filename ?? "", alt: sent.alt ?? "", bytes: Buffer.from(sent.data ?? "", "base64") });
      return json(200, { name: "photo-1a2b3c4d.webp", url: "/media/photo-1a2b3c4d.webp", width: 800, height: 800 });
    }
    const rest = url.pathname.replace(/^\/cms-api\/pages/, "");
    if (rest === "/sections" && method === "GET") return json(200, SHAPE);
    if (rest === "" && method === "GET") {
      if (lang === "all") {
        const onlyLive = url.searchParams.get("where[_status][equals]") === "published";
        return json(200, { docs: docs.filter((d) => !onlyLive || d.mainStatus === "published").map((d) => all(d, draft, url)) });
      }
      const wanted = url.searchParams.get("where[path][equals]");
      const liveOnly = url.searchParams.get("where[_status][equals]") === "published";
      return json(200, { docs: docs.filter((d) => (draft ? d.latest : d.main)[lang]?.path === wanted && (!liveOnly || d.mainStatus === "published")).map((d) => view(d, lang, draft)) });
    }
    if (rest === "" && method === "POST") {
      const problem = pathProblem(body.path, lang);
      if (problem) return refuse(problem);
      const { _status, ...content } = body;
      const d: Doc = { id: nextId++, main: { [lang]: content }, mainStatus: "draft", latest: { [lang]: structuredClone(content) }, latestStatus: "draft" };
      docs.push(d);
      return json(201, { doc: view(d, lang, true) });
    }
    const d = docs.find((x) => String(x.id) === rest.slice(1));
    if (!d) return json(404, { errors: [{ message: "Not Found" }] });
    if (method === "GET") return json(200, view(d, lang, draft));
    if (method === "DELETE") return json(403, { errors: [{ message: "You are not allowed to perform this action." }] });
    if (method === "PATCH") {
      const { _status, ...content } = body;
      if (content.path !== undefined) {
        const problem = pathProblem(content.path, lang, d.id);
        if (problem) return refuse(problem);
      }
      d.latest[lang] = { ...(d.latest[lang] ?? {}), ...content };
      if (draft || _status !== "published") {
        d.latestStatus = "draft";
        return json(200, { doc: view(d, lang, true) });
      }
      if (!d.latest[lang]?.meta?.description) return json(400, { errors: [{ message: "The following field is invalid: Search and sharing > Description", data: { errors: [{ path: "meta.description", message: "This field is required." }] } }] });
      d.main = structuredClone(d.latest);
      d.mainStatus = d.latestStatus = "published";
      return json(200, { doc: view(d, lang, false) });
    }
    return json(405, {});
  }) as typeof fetch;

  /** Seed a page that is live, as the site would hold it. */
  const live = (byLang: Record<string, Content>): Doc => {
    const d: Doc = { id: nextId++, main: structuredClone(byLang), mainStatus: "published", latest: structuredClone(byLang), latestStatus: "published" };
    docs.push(d);
    return d;
  };
  return { fetchImpl, docs, live, calls, uploads };
}

let tmp: string;
let broker: Broker;
let site: ReturnType<typeof fakeSite>;
let secret: string;

const roles: Record<string, string | null> = { [OWNER]: "owner", [MEMBER]: "member", [STRANGER]: null };

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "site-"));
  site = fakeSite();
  secret = JSON.stringify({ apiKey: KEY, previewSecret: SECRET });
  broker = createBroker({
    store: createStore({ root: path.join(tmp, "clones"), token: async () => "", fetchEveryMs: 0, log: () => {} }),
    scratch: path.join(tmp, "scratch"),
    log: () => {},
    registry: {
      reach: async (_agent, user): Promise<Reach> => ({ tenant: "test-a", speaker: { accountId: user, name: user, member: user !== STRANGER, role: roles[user] }, brains: [] }),
      recordRepo: async () => {},
    },
    siteSecret: async () => secret,
    fetch: site.fetchImpl,
  });
  await broker.start();
});

afterEach(async () => {
  await broker.close();
  rmSync(tmp, { recursive: true, force: true });
});

const SITE_ON = { url: SITE, api: `${SITE}/cms-api`, secretRef: "registry:website.site" };
const turn = (user: string, withSite = true) => broker.startTurn({ agentGuid: "agent-1", slackUserId: user, who: user, ...(withSite ? { site: SITE_ON } : {}) }).token;
const run = async (token: string, command: string, body: Record<string, unknown> = {}) => {
  const r = await fetch(`${broker.url}/site/${command}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};

const TEAM = {
  en: { title: "The Team", path: "/team", summary: "Who we are.", meta: { description: "Meet the people behind the Lab." }, layout: [{ id: "a1", blockType: "hero", title: "The people behind the Lab", sub: "Creators helping creators." }, { id: "a2", blockType: "text", heading: "Priya Raman", body: "Priya sets the direction. Priya also builds." }] },
  es: { title: "El Equipo", path: "/es/equipo", summary: "Quiénes somos.", meta: { description: "Conoce a las personas detrás del Lab." }, layout: [{ id: "b1", blockType: "hero", title: "Las personas detrás del Lab" }] },
};

describe("the Talent", () => {
  it("SITE-IS-A-TALENT without Website on for the agent, tonoman site says so and does nothing", async () => {
    const r = await run(turn(OWNER, false), "pages");
    expect(r.status).toBe(403);
    expect(r.text).toContain("Website is not on for this agent");
    expect(site.calls).toEqual([]);
  });

  it("SITE-IS-A-TALENT the turn's environment offers the site group only when the Talent is on", () => {
    expect(broker.startTurn({ agentGuid: "a", slackUserId: OWNER, who: "o", site: SITE_ON }).cli.env.TONOMAN_SITE).toBe("1");
    expect(broker.startTurn({ agentGuid: "a", slackUserId: OWNER, who: "o" }).cli.env.TONOMAN_SITE).toBeUndefined();
  });

  it("SITE-CONNECTED-ONCE on, but with no key stored for the site, it says the site is not connected", async () => {
    secret = "";
    const r = await run(turn(OWNER), "pages");
    expect(r.status).toBe(409);
    expect(r.text).toContain("not connected yet");
    expect(site.calls).toEqual([]);
  });

  it("SITE-CONNECTED-ONCE the agent's site is its Talent's address and its website connection; either missing, there is none", () => {
    const talents = [{ name: "website", version: 1, config: { site: "https://site.test/", api: "https://site.test/cms-api" } }];
    const creds = [{ kind: "website", secret_ref: "registry:website.site" }];
    expect(siteOf(talents, creds)).toEqual({ url: "https://site.test", api: "https://site.test/cms-api", secretRef: "registry:website.site", version: 1 });
    expect(siteOf(talents, [])).toBeUndefined();
    expect(siteOf([{ name: "website", config: {} }], creds)).toBeUndefined();
    expect(siteOf([{ name: "receipts", config: { site: "https://x.test" } }], creds)).toBeUndefined();
    expect(siteOf([{ name: "website", config: { site: "not an address" } }], creds)).toBeUndefined();
  });

  it("SITE-KEY-IS-THE-AGENTS a key the site does not accept is said as that, and nothing is changed", async () => {
    secret = JSON.stringify({ apiKey: "wrong", previewSecret: SECRET });
    const r = await run(turn(OWNER), "pages");
    expect(r.status).toBe(403);
    expect(r.text).toContain("The site said");
  });

  it("SITE-KEY-IS-THE-AGENTS someone who is not a member of the tenant reaches nothing of the site", async () => {
    site.live(TEAM);
    const r = await run(turn(STRANGER), "pages");
    expect(r.status).toBe(403);
    expect(site.calls).toEqual([]);
  });
});

describe("reading", () => {
  it("SITE-LISTS-PAGES every page with its address in each language, its title, and whether it is live", async () => {
    site.live(TEAM);
    const t = turn(MEMBER);
    await run(t, "save", { path: "/news", lang: "en", json: JSON.stringify({ title: "News", meta: { description: "d" }, layout: [{ blockType: "text", body: "Soon." }] }) });
    await run(t, "edit", { path: "/team", lang: "en", find: "Creators helping creators.", replace: "Creators helping creators grow." });
    const r = await run(t, "pages");
    expect(r.status).toBe(200);
    expect(r.text).toContain("/news (en) — “News” — a draft, not published yet");
    expect(r.text).toContain("/team (en) · /es/equipo (es) — “The Team” — published, with changes waiting as a draft");
  });

  it("SITE-LISTS-PAGES a page that is live with nothing waiting is listed as published, not as having changes", async () => {
    site.live(TEAM);
    const line = (await run(turn(MEMBER), "pages")).text.split("\n").find((l) => l.includes("“The Team”"));
    expect(line).toMatch(/— published$/);
  });

  it("SITE-READS-A-PAGE a page is its words and its sections by number; one section in full when asked", async () => {
    site.live(TEAM);
    const t = turn(MEMBER);
    const outline = await run(t, "read", { path: "/team" });
    expect(outline.text).toContain("/team (en) — published");
    expect(outline.text).toContain("Other languages — es: /es/equipo");
    expect(outline.text).toContain("description: Meet the people behind the Lab.");
    expect(outline.text).toContain("1. hero — The people behind the Lab");
    expect(outline.text).toContain("2. text — Priya Raman");
    const one = await run(t, "read", { path: "/team", lang: "en", section: "2" });
    expect(JSON.parse(one.text.slice(one.text.indexOf("{")))).toEqual({ blockType: "text", heading: "Priya Raman", body: "Priya sets the direction. Priya also builds." });
    expect((await run(t, "read", { path: "/nope" })).status).toBe(404);
  });

  it("SITE-READS-A-PAGE a draft waiting from an earlier request is said first, with what it changes; --live shows what visitors see", async () => {
    // What happened on Oct 3: a person was taken off the team page in a draft, and later asked about
    // their bio. The agent read the draft, found nobody, and said they were not on the page.
    site.live(TEAM);
    const t = turn(MEMBER);
    await run(t, "save", { path: "/team", lang: "en", remove: "2" });
    const draft = await run(t, "read", { path: "/team", lang: "en" });
    expect(draft.text).toContain("published, with changes waiting as a draft");
    expect(draft.text).toContain("CHANGES WAITING");
    expect(draft.text).toContain("sections: 2 live → 1 in the draft");
    expect(draft.text).toContain("removed in the draft: “Priya Raman”");
    expect(draft.text).toContain("--live");
    const live = await run(t, "read", { path: "/team", lang: "en", live: true });
    expect(live.text).toContain("the LIVE version, as visitors see it now");
    expect(live.text).toContain("2. text — Priya Raman");
    expect(live.text).not.toContain("CHANGES WAITING");
    // The draft is the whole page's; a language it did not change says so, with no warning.
    const es = (await run(t, "read", { path: "/es/equipo", lang: "es" })).text;
    expect(es).not.toContain("CHANGES WAITING");
    expect(es).toContain("Nothing is waiting in es");
    // A page that was never published has no live version to show.
    await run(t, "save", { path: "/news", lang: "en", json: JSON.stringify({ title: "News", meta: { description: "d" }, layout: [{ blockType: "text", body: "x" }] }) });
    expect((await run(t, "read", { path: "/news", lang: "en", live: true })).text).toContain("is not published; it exists only as a draft");
  });

  it("SITE-TELLS-ITS-SECTIONS the kinds of section and their fields come from the site itself", async () => {
    const r = await run(turn(MEMBER), "sections");
    expect(r.text).toContain("The site's languages: en, es");
    expect(r.text).toContain("- hero (Hero): variant(centered|home), eyebrow, title*, sub");
    expect(r.text).toContain("- faq (FAQ): heading, items*[question*, answer*]");
    const one = await run(turn(MEMBER), "sections", { kind: "text" });
    expect(one.text).toContain("body (required): textarea");
  });
});

describe("changing", () => {
  it("SITE-CHANGES-ARE-DRAFTS a change to a live page is saved as a draft; what visitors see does not change", async () => {
    const d = site.live(TEAM);
    const r = await run(turn(MEMBER), "edit", { path: "/team", lang: "en", find: "The people behind the Lab", replace: "The people behind the Lab." });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Saved as a draft");
    expect(r.text).toContain("It is NOT live");
    expect(d.mainStatus).toBe("published");
    expect(d.main.en!.layout![0]!.title).toBe("The people behind the Lab");
    expect(d.latest.en!.layout![0]!.title).toBe("The people behind the Lab.");
    expect(d.latestStatus).toBe("draft");
  });

  it("SITE-CHANGES-ARE-DRAFTS no command that changes a page sends a publish, whatever the JSON says", async () => {
    site.live(TEAM);
    const t = turn(OWNER);
    await run(t, "save", { path: "/news", lang: "en", json: JSON.stringify({ title: "News", _status: "published", meta: { description: "d" }, layout: [{ blockType: "text", body: "x" }] }) });
    await run(t, "save", { path: "/team", lang: "en", section: "1", json: JSON.stringify({ blockType: "hero", title: "New" }) });
    expect(site.docs.find((d) => d.latest.en?.path === "/news")!.mainStatus).toBe("draft");
    expect(site.docs.find((d) => d.main.en?.path === "/team")!.main.en!.layout![0]!.title).toBe("The people behind the Lab");
  });

  it("SITE-EDIT-IN-PLACE the words are found once and replaced; twice, the agent is told where; never, told so", async () => {
    const d = site.live(TEAM);
    const t = turn(MEMBER);
    const twice = await run(t, "edit", { path: "/team", lang: "en", find: "Priya", replace: "Priyanka" });
    expect(twice.status).toBe(409);
    expect(twice.text).toContain("3 times");
    expect(twice.text).toContain("section 2 (text) · heading");
    const none = await run(t, "edit", { path: "/team", lang: "en", find: "Patricia", replace: "x" });
    expect(none.status).toBe(404);
    const once = await run(t, "edit", { path: "/team", lang: "en", find: "Priya also builds.", replace: "She also builds." });
    expect(once.status).toBe(200);
    expect(once.text).toContain("section 2 (text) · body");
    expect(d.latest.en!.layout![1]).toMatchObject({ heading: "Priya Raman", body: "Priya sets the direction. She also builds." });
    // The other language and every other field are as they were.
    expect(d.latest.es).toEqual(TEAM.es);
    expect(d.latest.en!.title).toBe("The Team");
  });

  it("SITE-SAVE-A-SECTION one section is replaced, put in or taken out; the rest of the page stays", async () => {
    const d = site.live(TEAM);
    const t = turn(MEMBER);
    expect((await run(t, "save", { path: "/team", lang: "en", insert: "2", json: JSON.stringify({ blockType: "faq", heading: "Questions", items: [{ question: "Who?", answer: "Us." }] }) })).status).toBe(200);
    expect(d.latest.en!.layout!.map((b) => b.blockType)).toEqual(["hero", "faq", "text"]);
    expect((await run(t, "save", { path: "/team", lang: "en", section: "1", json: JSON.stringify({ blockType: "hero", title: "Our people" }) })).status).toBe(200);
    expect(d.latest.en!.layout![0]).toEqual({ blockType: "hero", title: "Our people" });
    expect((await run(t, "save", { path: "/team", lang: "en", remove: "3" })).text).toContain("section 3 (text) removed");
    expect(d.latest.en!.layout!.map((b) => b.blockType)).toEqual(["hero", "faq"]);
    expect((await run(t, "save", { path: "/team", lang: "en", remove: "9" })).status).toBe(400);
  });

  it("SITE-SAVE-A-SECTION a whole page makes a new page, and --same-as makes its other language", async () => {
    const t = turn(MEMBER);
    const en = await run(t, "save", { path: "/newsletter", lang: "en", json: JSON.stringify({ title: "Newsletter", summary: "Weekly tips.", meta: { description: "Weekly AI tips for creators." }, layout: [{ blockType: "hero", title: "The newsletter" }] }) });
    expect(en.text).toContain("a new page at /newsletter (en)");
    const es = await run(t, "save", { path: "/es/boletin", lang: "es", sameAs: "/newsletter", json: JSON.stringify({ title: "Boletín", meta: { description: "Consejos semanales." }, layout: [{ blockType: "hero", title: "El boletín" }] }) });
    expect(es.text).toContain("the es version of /newsletter");
    expect(site.docs).toHaveLength(1);
    expect(site.docs[0]!.latest.es!.path).toBe("/es/boletin");
    expect(site.docs[0]!.mainStatus).toBe("draft");
  });

  it("SITE-REFUSALS-ARE-RELAYED what the site refuses comes back in its words and nothing is saved", async () => {
    site.live(TEAM);
    const t = turn(MEMBER);
    const page = (over: Record<string, unknown> = {}) => JSON.stringify({ title: "X", meta: { description: "d" }, layout: [{ blockType: "text", body: "b" }], ...over });
    const taken = await run(t, "save", { path: "/team", lang: "es", sameAs: "/team", json: page() });
    expect(taken.status).toBe(422);
    expect(taken.text).toContain("The site said: A Spanish address starts with /es/");
    const kept = await run(t, "save", { path: "/admin/x", lang: "en", json: page() });
    expect(kept.text).toContain("/admin/x is kept for the site itself");
    const kind = await run(t, "save", { path: "/y", lang: "en", json: page({ layout: [{ blockType: "carousel" }] }) });
    expect(kind.text).toContain("“carousel” is not a kind of section this site has. The kinds are: hero, text, faq.");
    const lacks = await run(t, "save", { path: "/y", lang: "en", json: page({ layout: [{ blockType: "faq", items: [{ question: "Q" }] }] }) });
    expect(lacks.text).toContain("the faq section needs: items[1].answer");
    const extra = await run(t, "save", { path: "/y", lang: "en", json: page({ layout: [{ blockType: "text", body: "b", colour: "red" }] }) });
    expect(extra.text).toContain("a text section has no field “colour”");
    expect((await run(t, "save", { path: "/y", lang: "fr", json: page() })).text).toContain("The site's languages are en, es");
    expect(site.docs).toHaveLength(1);
  });

  it("SITE-PREVIEW-LINK every save answers with the link that shows the draft on the real site", async () => {
    site.live(TEAM);
    const t = turn(MEMBER);
    const link = `${SITE}/team?preview=${SECRET}`;
    expect((await run(t, "edit", { path: "/team", lang: "en", find: "Creators helping creators.", replace: "x" })).text).toContain(`Preview (the draft, on the real site): ${link}`);
    expect((await run(t, "preview", { path: "/team" })).text).toContain(link);
    expect((await run(t, "save", { path: "/es/equipo", lang: "es", section: "1", json: JSON.stringify({ blockType: "hero", title: "Equipo" }) })).text).toContain(`${SITE}/es/equipo?preview=${SECRET}`);
  });

  it("SITE-PAGE-HAS-ITS-SEO a new page saved with no description is saved, and the agent is told it cannot be published like that", async () => {
    const r = await run(turn(MEMBER), "save", { path: "/bare", lang: "en", json: JSON.stringify({ title: "Bare", layout: [{ blockType: "text", body: "b" }] }) });
    expect(r.status).toBe(200);
    expect(r.text).toContain("It has no description yet; the site will not publish a page without one");
  });
});

describe("images", () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a photo")]);
  const PDF = Buffer.from("%PDF-1.7 a document");
  const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(12)]);
  /** A turn where the person sent these files (the worker hands them over before the agent runs). */
  const sending = (user: string, files: { name: string; bytes: Buffer }[]) => {
    const t = turn(user);
    broker.attach(t, files);
    return t;
  };

  it("SITE-IMAGE-FROM-THE-CONVERSATION a photo the person sent goes to the site as it arrived, and the answer is its address there", async () => {
    const r = await run(sending(MEMBER, [{ name: "priya.jpg", bytes: JPEG }]), "upload", { file: "priya.jpg", alt: "Priya Raman" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("/media/photo-1a2b3c4d.webp");
    expect(site.uploads).toEqual([{ filename: "priya.jpg", alt: "Priya Raman", bytes: JPEG }]);
  });

  it("SITE-IMAGE-FROM-THE-CONVERSATION only a file the person sent: another name, or a path elsewhere, is refused and nothing is sent", async () => {
    const t = sending(MEMBER, [{ name: "priya.jpg", bytes: JPEG }]);
    for (const file of ["other.jpg", "/etc/priya.jpg", "../priya.jpg", ""]) {
      const r = await run(t, "upload", { file });
      expect(r.status, file).toBeGreaterThanOrEqual(400);
    }
    expect(site.uploads).toEqual([]);
  });

  it("SITE-IMAGE-FROM-THE-CONVERSATION a file that is not a JPEG, PNG or WebP is refused before anything is sent", async () => {
    const t = sending(MEMBER, [{ name: "cv.pdf", bytes: PDF }, { name: "IMG_1.heic", bytes: HEIC }, { name: "fake.jpg", bytes: Buffer.from("not a photo") }]);
    expect((await run(t, "upload", { file: "cv.pdf" })).status).toBe(422);
    const heic = await run(t, "upload", { file: "IMG_1.heic" });
    expect(heic.status).toBe(422);
    expect(heic.text).toContain("JPEG");
    expect((await run(t, "upload", { file: "fake.jpg" })).status).toBe(422);
    expect(site.uploads).toEqual([]);
  });

  it("SITE-UPLOAD-IS-NOT-PUBLISHING an upload touches no page, and says the image shows only where a saved page uses it", async () => {
    site.live(TEAM);
    const r = await run(sending(MEMBER, [{ name: "priya.jpg", bytes: JPEG }]), "upload", { file: "priya.jpg" });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/no page shows it yet/i);
    expect(site.calls.filter((c) => c.includes("/pages"))).toEqual([]);
  });

  it("SITE-KEY-IS-THE-AGENTS someone who is not a member uploads nothing", async () => {
    const r = await run(sending(STRANGER, [{ name: "priya.jpg", bytes: JPEG }]), "upload", { file: "priya.jpg" });
    expect(r.status).toBe(403);
    expect(site.uploads).toEqual([]);
  });
});

describe("publishing", () => {
  it("SITE-PUBLISH-NEEDS-AN-OWNER a member's publish does nothing and says who can; an owner's publishes", async () => {
    const d = site.live(TEAM);
    await run(turn(MEMBER), "edit", { path: "/team", lang: "en", find: "Creators helping creators.", replace: "Creators helping creators grow." });
    const before = site.calls.length;
    const refused = await run(turn(MEMBER), "publish", { path: "/team" });
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("Nothing was published. Only an owner or admin of this tenant can publish the site");
    // Not one request went to the site.
    expect(site.calls.length).toBe(before);
    expect(d.main.en!.layout![0]!.sub).toBe("Creators helping creators.");
    const done = await run(turn(OWNER), "publish", { path: "/team" });
    expect(done.status).toBe(200);
    expect(d.main.en!.layout![0]!.sub).toBe("Creators helping creators grow.");
  });

  it("SITE-PUBLISH-IS-WHAT-WAS-PREVIEWED publish sends no words of its own: the latest draft goes live, in every language", async () => {
    const d = site.live(TEAM);
    const t = turn(OWNER);
    await run(t, "edit", { path: "/team", lang: "en", find: "The Team", replace: "Our Team" });
    await run(t, "edit", { path: "/es/equipo", lang: "es", find: "El Equipo", replace: "Nuestro Equipo" });
    const previewed = structuredClone(d.latest);
    await run(t, "publish", { path: "/team" });
    expect(d.main).toEqual(previewed);
    const publish = site.calls.filter((c) => c.startsWith("PATCH") && !c.includes("draft=true"));
    expect(publish).toHaveLength(1);
  });

  it("SITE-PUBLISH-SAYS-WHERE a publish answers with the live address in each language; with nothing waiting it says so", async () => {
    site.live(TEAM);
    const t = turn(OWNER);
    expect((await run(t, "publish", { path: "/team" })).text).toContain("Nothing is waiting: /team is already live");
    await run(t, "edit", { path: "/team", lang: "en", find: "The Team", replace: "Our Team" });
    const r = await run(t, "publish", { path: "/team" });
    expect(r.text).toContain(`- en: ${SITE}/team`);
    expect(r.text).toContain(`- es: ${SITE}/es/equipo`);
  });

  it("SITE-PAGE-HAS-ITS-SEO the site will not publish a page without a description, and says which field", async () => {
    const t = turn(OWNER);
    await run(t, "save", { path: "/bare", lang: "en", json: JSON.stringify({ title: "Bare", layout: [{ blockType: "text", body: "b" }] }) });
    const r = await run(t, "publish", { path: "/bare" });
    expect(r.status).toBe(422);
    expect(r.text).toContain("The site said: meta.description: This field is required.");
    expect(site.docs[0]!.mainStatus).toBe("draft");
  });
});

describe("web fetch", () => {
  it("TOOL-WEB-FETCH without the grant `tonoman web fetch` does nothing; with it, the page comes back", async () => {
    const opened: string[] = [];
    const b = createBroker({
      store: createStore({ root: path.join(tmp, "c2"), token: async () => "", fetchEveryMs: 0, log: () => {} }),
      scratch: path.join(tmp, "s2"),
      log: () => {},
      registry: { reach: async (): Promise<Reach> => ({ tenant: "test-a", speaker: { accountId: "a", name: "A", member: true, role: "member" }, brains: [] }), recordRepo: async () => {} },
      fetchPage: async (url) => (opened.push(url), { url, status: 200, title: "Priya Raman - Acme", description: "Head of data", text: "x".repeat(6000) }),
    });
    await b.start();
    try {
      const go = async (webFetch: boolean, body: Record<string, unknown>) => {
        const { token, cli } = b.startTurn({ agentGuid: "g", slackUserId: "U1", who: "A", webFetch });
        const r = await fetch(`${b.url}/web/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, text: await r.text(), env: cli.env };
      };
      const off = await go(false, { url: "https://example.com/" });
      expect(off.status).toBe(403);
      expect(off.env.TONOMAN_WEB_FETCH).toBeUndefined();
      expect(opened).toEqual([]);
      const on = await go(true, { url: "https://example.com/" });
      expect(on.env.TONOMAN_WEB_FETCH).toBe("1");
      expect(on.text).toContain("title: Priya Raman - Acme");
      expect(on.text).toContain("1000 more characters: --from 5000");
    } finally {
      await b.close();
    }
  });
});

describe("the pure parts", () => {
  it("SITE-EDIT-IN-PLACE occurrences are counted in words only, never in ids or kinds", () => {
    const page = { title: "text", summary: null, meta: { description: "A text" }, layout: [{ id: "text", blockType: "text", body: "text and text" }] };
    expect(occurrences(page, "text").map((h) => h.where)).toEqual(["title", "description", "section 1 (text) · body", "section 1 (text) · body"]);
  });

  it("SITE-READS-A-PAGE what the agent is shown has no ids and no empty fields", () => {
    expect(tidy({ id: "x", blockType: "hero", title: "T", sub: null, card: { badge: "", chips: [] }, items: [{ id: "y", text: "a" }] })).toEqual({ blockType: "hero", title: "T", items: [{ text: "a" }] });
  });

  it("SITE-REFUSALS-ARE-RELAYED a section is checked against the site's own description of it", () => {
    expect(sectionProblem({ blockType: "hero", title: "T", variant: "home" }, SHAPE)).toBeNull();
    expect(sectionProblem({ blockType: "hero", title: "T", variant: "wide" }, SHAPE)).toContain("variant (one of: centered, home)");
    expect(sectionProblem({ blockType: "hero" }, SHAPE)).toContain("needs: title");
    expect(sectionProblem("hero", SHAPE)).toContain("a section is an object");
  });

  it("SITE-LISTS-PAGES an address is written the way the site writes it", () => {
    expect(normPath("Team/")).toBe("/team");
    expect(normPath("//es//equipo")).toBe("/es/equipo");
    expect(normPath("/")).toBe("/");
    expect(normPath("")).toBe("");
  });
});
