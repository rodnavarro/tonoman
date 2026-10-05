// `tonoman site …` — what the Website Talent lets an agent do to a tenant's site (website.md in
// Tonoman Cloud). Each command is a function of the site, what was asked, and who is speaking; it
// answers in words the agent can pass on. The rules that matter are here, not in the agent's
// goodwill: every save is a draft, and only an owner or admin can publish.

import { SiteRefused, type FieldInfo, type PayloadSite, type SitePage, type SiteShape } from "./payload";

export interface SiteSpeaker {
  member: boolean;
  /** The speaker's role in the tenant: owner, admin, member — or nothing for someone outside it. */
  role?: string | null;
  name?: string | null;
}

export interface Out {
  status: number;
  text: string;
}

type Args = Record<string, unknown>;
type Block = Record<string, unknown>;

const ok = (text: string): Out => ({ status: 200, text });
const no = (status: number, text: string): Out => ({ status, text });
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const MAY_PUBLISH = new Set(["owner", "admin"]);

/** PURE: why this file cannot go on the site as an image, or null when it can
 *  (SITE-IMAGE-FROM-THE-CONVERSATION). Checked on its first bytes, not only its name. */
export function imageTrouble(name: string, bytes: Buffer): string | null {
  const e = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  if (/^(heic|heif)$/.test(e)) return "A HEIC photo cannot go on the site as it is. Ask the person to send it as a JPEG (on an iPhone: share it, or set Camera > Formats to Most Compatible).";
  if (!["jpg", "jpeg", "png", "webp"].includes(e)) return `A .${e || "?"} file is not an image the site takes (JPEG, PNG or WebP).`;
  if (bytes.length === 0) return "That file is empty.";
  if (bytes.length > 15 * 1024 * 1024) return "That image is over 15 MB.";
  const starts = (...b: number[]) => b.every((v, i) => bytes[i] === v);
  const is =
    e === "png" ? starts(0x89, 0x50, 0x4e, 0x47)
    : e === "webp" ? bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"
    : starts(0xff, 0xd8, 0xff);
  return is ? null : `That file is called .${e} but is not one, or it is damaged. Ask the person to send it again.`;
}

/** PURE: an address as the site writes it. */
export function normPath(v: unknown): string {
  let p = str(v).toLowerCase();
  if (!p) return "";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

const STATE_WORDS = {
  published: "published",
  changes: "published, with changes waiting as a draft",
  draft: "a draft, not published yet",
} as const;

/** PURE: a value as the agent should see it — no ids, no empty fields. */
export function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "id" || k === "blockName") continue;
      if (x === null || x === undefined || x === "") continue;
      if (Array.isArray(x) && x.length === 0) continue;
      const t = tidy(x);
      if (t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).length === 0) continue;
      out[k] = t;
    }
    return out;
  }
  return v;
}

/** PURE: one line that says what a section is about. */
export function gist(b: Block): string {
  for (const k of ["title", "heading", "cap", "lead", "body", "html"]) {
    const s = str(b[k]);
    if (s) return s.replace(/\s+/g, " ").slice(0, 70) + (s.length > 70 ? "…" : "");
  }
  return "";
}

/** PURE: every place `find` occurs in a page's words. Ids and kinds are not words. */
export function occurrences(page: Pick<SitePage, "title" | "summary" | "meta" | "layout">, find: string): { where: string; set: (next: string) => void; value: string }[] {
  const hits: { where: string; set: (next: string) => void; value: string }[] = [];
  const count = (s: string) => s.split(find).length - 1;
  const look = (holder: Record<string, unknown> | unknown[], key: string | number, where: string) => {
    const v = (holder as Record<string | number, unknown>)[key];
    if (typeof v === "string") {
      for (let n = count(v); n > 0; n--) hits.push({ where, value: v, set: (next) => ((holder as Record<string | number, unknown>)[key] = next) });
    } else if (Array.isArray(v)) v.forEach((_, i) => look(v, i, `${where}[${i + 1}]`));
    else if (v && typeof v === "object") {
      for (const k of Object.keys(v)) if (k !== "id" && k !== "blockType" && k !== "blockName") look(v as Record<string, unknown>, k, `${where} · ${k}`);
    }
  };
  const p = page as Record<string, unknown>;
  look(p, "title", "title");
  look(p, "summary", "summary");
  if (page.meta) for (const k of ["titleTag", "description"]) look(page.meta as Record<string, unknown>, k, k === "titleTag" ? "search title" : "description");
  (page.layout ?? []).forEach((b, i) => {
    for (const k of Object.keys(b)) if (k !== "id" && k !== "blockType" && k !== "blockName") look(b, k, `section ${i + 1} (${String(b.blockType)}) · ${k}`);
  });
  return hits;
}

/** PURE: the names a version of a page shows — people, titles, headings, questions — for saying in
 *  a line what a waiting draft changes. */
function labels(page: Pick<SitePage, "title" | "layout">): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (["name", "title", "heading", "question"].includes(k) && typeof x === "string" && x.trim()) out.push(x.trim());
        else walk(x);
      }
    }
  };
  if (page.title) out.push(page.title);
  walk(page.layout ?? []);
  return out;
}

/** PURE: what a waiting draft changes against the live page, in a few lines a person can follow. */
export function draftChanges(live: Pick<SitePage, "title" | "summary" | "meta" | "layout">, draft: Pick<SitePage, "title" | "summary" | "meta" | "layout">): string[] {
  const out: string[] = [];
  const [a, b] = [live.layout ?? [], draft.layout ?? []];
  const same = (x: unknown, y: unknown) => JSON.stringify(tidy(x)) === JSON.stringify(tidy(y));
  if (!same(live.title, draft.title)) out.push(`title: “${live.title ?? ""}” → “${draft.title ?? ""}”`);
  if (!same(live.meta, draft.meta) || !same(live.summary, draft.summary)) out.push("description or summary changed");
  if (a.length !== b.length) out.push(`sections: ${a.length} live → ${b.length} in the draft`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (!same(a[i], b[i])) out.push(`section ${i + 1} (${String(b[i]!.blockType)}) changed`);
  const [la, lb] = [labels(live), labels(draft)];
  const gone = la.filter((x) => !lb.includes(x));
  const added = lb.filter((x) => !la.includes(x));
  if (gone.length) out.push(`removed in the draft: ${gone.map((x) => `“${x}”`).join(", ")}`);
  if (added.length) out.push(`added in the draft: ${added.map((x) => `“${x}”`).join(", ")}`);
  return out;
}

/** PURE: what is wrong with a section, by the site's own description of its sections — or null. */
export function sectionProblem(b: unknown, shape: SiteShape): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "a section is an object with a blockType";
  const kind = str((b as Block).blockType);
  const spec = shape.sections.find((s) => s.blockType === kind);
  if (!spec) return `${kind ? `“${kind}” is not a kind of section this site has` : "the section has no blockType"}. The kinds are: ${shape.sections.map((s) => s.blockType).join(", ")}.`;
  const missing = (fields: FieldInfo[], v: Record<string, unknown>, at: string): string[] =>
    fields.flatMap((f) => {
      const x = v[f.name];
      const empty = x === undefined || x === null || x === "" || (Array.isArray(x) && x.length === 0);
      if (empty) return f.required ? [`${at}${f.name}`] : [];
      if (f.options && typeof x === "string" && !f.options.includes(x)) return [`${at}${f.name} (one of: ${f.options.join(", ")})`];
      if (f.type === "array" && Array.isArray(x) && f.fields) return x.flatMap((item, i) => (item && typeof item === "object" ? missing(f.fields!, item as Record<string, unknown>, `${at}${f.name}[${i + 1}].`) : [`${at}${f.name}[${i + 1}]`]));
      if (f.type === "group" && x && typeof x === "object" && f.fields) return missing(f.fields, x as Record<string, unknown>, `${at}${f.name}.`);
      return [];
    });
  const known = new Set([...spec.fields.map((f) => f.name), "blockType", "id", "blockName"]);
  const unknown = Object.keys(b as Block).filter((k) => !known.has(k));
  if (unknown.length) return `a ${kind} section has no field ${unknown.map((k) => `“${k}”`).join(", ")}. Its fields: ${spec.fields.map((f) => f.name + (f.required ? "*" : "")).join(", ")}.`;
  const lacks = missing(spec.fields, b as Record<string, unknown>, "");
  return lacks.length ? `the ${kind} section needs: ${lacks.join(", ")}.` : null;
}

function fieldLine(f: FieldInfo): string {
  const star = f.required ? "*" : "";
  if (f.type === "array") return `${f.name}${star}[${(f.fields ?? []).map(fieldLine).join(", ")}]`;
  if (f.type === "group") return `${f.name}{${(f.fields ?? []).map(fieldLine).join(", ")}}`;
  if (f.options) return `${f.name}${star}(${f.options.join("|")})`;
  return `${f.name}${star}`;
}

async function findPage(site: PayloadSite, path: string, lang: string, langs: string[]): Promise<{ page: SitePage; lang: string } | null> {
  for (const l of lang ? [lang] : langs) {
    const page = await site.latest(path, l);
    if (page) return { page, lang: l };
  }
  return null;
}

const notFound = (path: string, lang: string): Out =>
  no(404, `There is no page at ${path}${lang ? ` in ${lang}` : ""}. \`tonoman site pages\` lists every page and its address in each language.`);

function parseJson(a: Args): { value: unknown } | Out {
  const raw = str(a.json) || str(a.content);
  if (!raw) return no(400, "Give the section or the page as JSON: --json '{…}' (or on stdin).");
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return no(400, `That JSON could not be read: ${(e as Error).message}.`);
  }
}

const savedText = (site: PayloadSite, what: string, path: string): string =>
  [
    `Saved as a draft: ${what}`,
    `Preview (the draft, on the real site): ${site.previewLink(path)}`,
    "It is NOT live. Visitors still see the published page until an owner or admin says “publish”.",
  ].join("\n");

/** Run one `tonoman site` command. Whatever the site refuses comes back in its words. */
export async function runSite(command: string, site: PayloadSite, a: Args, who: SiteSpeaker): Promise<Out> {
  if (!who.member) return no(403, "This person is not a member of the tenant, so they cannot read or change its site through the agent.");
  try {
    switch (command) {
      case "pages": {
        const list = await site.pages();
        if (!list.length) return ok("The site has no pages in its content management yet.");
        const lines = list
          .map((p) => {
            const where = Object.entries(p.in).map(([l, x]) => `${x.path} (${l})`);
            const title = Object.values(p.in)[0]?.title ?? "";
            return { key: Object.values(p.in)[0]?.path ?? "", line: `${where.join(" · ")} — “${title}” — ${STATE_WORDS[p.state]}` };
          })
          .sort((x, y) => x.key.localeCompare(y.key));
        return ok([`${list.length} page(s):`, ...lines.map((l) => `- ${l.line}`), "", "Read one: tonoman site read --path <address> [--lang <language>]"].join("\n"));
      }

      case "sections": {
        const shape = await site.shape();
        const kind = str(a.kind);
        if (kind) {
          const s = shape.sections.find((x) => x.blockType === kind);
          if (!s) return no(404, `“${kind}” is not a kind of section this site has. The kinds are: ${shape.sections.map((x) => x.blockType).join(", ")}.`);
          const detail = (fields: FieldInfo[], pad: string): string[] =>
            fields.flatMap((f) => [
              `${pad}${f.name}${f.required ? " (required)" : ""}: ${f.type}${f.options ? ` — one of ${f.options.join(", ")}` : ""}${f.about ? ` — ${f.about}` : ""}`,
              ...(f.fields ? detail(f.fields, `${pad}  `) : []),
            ]);
          return ok([`${s.blockType} — ${s.label}`, ...detail(s.fields, "  ")].join("\n"));
        }
        return ok(
          [
            `The site's languages: ${shape.languages.join(", ")}. A page is an ordered list of sections; each is {"blockType": "<kind>", …fields}. * = required.`,
            ...shape.sections.map((s) => `- ${s.blockType} (${s.label}): ${s.fields.map(fieldLine).join(", ")}`),
            "",
            "One kind in full, with what each field is for: tonoman site sections --kind <kind>",
          ].join("\n"),
        );
      }

      case "read": {
        const path = normPath(a.path);
        if (!path) return no(400, "Say which page: --path <its address>.");
        const shape = await site.shape();
        let found = await findPage(site, path, str(a.lang), shape.languages);
        if (!found) return notFound(path, str(a.lang));
        // `--live`: the page as visitors see it now, not its waiting draft.
        if (a.live !== undefined && a.live !== false) {
          const live = await site.published(path, found.lang);
          if (!live) return no(404, `${path} (${found.lang}) is not published; it exists only as a draft.`);
          found = { page: { ...live, _status: "published" }, lang: found.lang };
        }
        const { page, lang } = found;
        const layout = page.layout ?? [];
        const state = a.live !== undefined && a.live !== false ? "published" : await site.stateOf(page);
        // A draft waiting from an earlier request is said FIRST, with what it changes: the agent reads
        // the draft, and without this a person asking about the live page is told something the live
        // page does not show.
        let waiting: string[] = [];
        if (state === "changes") {
          const live = await site.published(path, lang);
          const changes = live ? draftChanges(live, page) : [];
          if (live && !changes.length) {
            waiting = [`Nothing is waiting in ${lang}: this language of the draft is the same as the live page (the waiting changes are in another language).`];
          } else if (live) {
            waiting = [
              "⚠ This page has CHANGES WAITING as a draft, not live yet. What follows is the DRAFT. Against the live page:",
              ...changes.map((l) => `  - ${l}`),
              `  The live version: tonoman site read --path ${path} --lang ${lang} --live. Tell the person about these waiting changes before building on them.`,
            ];
          }
        }
        if (a.section !== undefined) {
          const n = Number(a.section);
          if (!Number.isInteger(n) || n < 1 || n > layout.length) return no(400, `The page has ${layout.length} section(s); --section takes 1 to ${layout.length}.`);
          return ok(`Section ${n} of ${path} (${lang}):\n${JSON.stringify(tidy(layout[n - 1]), null, 2)}`);
        }
        const others: string[] = [];
        for (const l of shape.languages) {
          if (l === lang) continue;
          const o = await site.latestById(page.id, l);
          others.push(o?.path ? `${l}: ${o.path}` : `${l}: not written yet`);
        }
        return ok(
          [
            `${path} (${lang}) — ${a.live !== undefined && a.live !== false ? "the LIVE version, as visitors see it now" : STATE_WORDS[state]}`,
            ...waiting,
            ...(others.length ? [`Other languages — ${others.join(" · ")}`] : []),
            `title: ${page.title ?? ""}`,
            ...(page.meta?.titleTag ? [`search title: ${page.meta.titleTag}`] : []),
            `description: ${page.meta?.description ?? "(none — the site will not publish without one)"}`,
            `summary: ${page.summary ?? "(none)"}`,
            "sections:",
            ...layout.map((b, i) => `  ${i + 1}. ${String(b.blockType)}${gist(b) ? ` — ${gist(b)}` : ""}`),
            "",
            `One section in full: tonoman site read --path ${path} --lang ${lang} --section <number>`,
            `Preview: ${site.previewLink(path)}`,
          ].join("\n"),
        );
      }

      case "preview": {
        const path = normPath(a.path);
        if (!path) return no(400, "Say which page: --path <its address>.");
        const shape = await site.shape();
        const found = await findPage(site, path, str(a.lang), shape.languages);
        if (!found) return notFound(path, str(a.lang));
        return ok(`Preview of ${path} — its latest saved version, on the real site, for whoever holds the link: ${site.previewLink(path)}`);
      }

      case "edit": {
        const path = normPath(a.path);
        const lang = str(a.lang);
        const find = typeof a.find === "string" ? a.find : "";
        const replace = typeof a.replace === "string" ? a.replace : undefined;
        if (!path || !lang) return no(400, "Say which page and language: --path <address> --lang <language>.");
        if (!find || replace === undefined) return no(400, "Give --find (the exact words there now) and --replace (what to put instead).");
        if (find === replace) return no(400, "That would change nothing.");
        const page = await site.latest(path, lang);
        if (!page) return notFound(path, lang);
        const draft = structuredClone({ title: page.title, summary: page.summary, meta: page.meta, layout: page.layout }) as Pick<SitePage, "title" | "summary" | "meta" | "layout">;
        const hits = occurrences(draft, find);
        if (hits.length === 0) return no(404, `Those words are not on ${path} (${lang}). Read the page first and copy the words exactly — capitals and punctuation count.`);
        if (hits.length > 1) {
          return no(409, `Those words are on ${path} (${lang}) ${hits.length} times: ${[...new Set(hits.map((h) => h.where))].join("; ")}. Give more of the surrounding words so they are found once.`);
        }
        hits[0]!.set(hits[0]!.value.replace(find, () => replace));
        await site.saveDraft(lang, draft, page.id);
        return ok(savedText(site, `${path} (${lang}), ${hits[0]!.where}.`, path));
      }

      case "save": {
        const path = normPath(a.path);
        const lang = str(a.lang);
        if (!path || !lang) return no(400, "Say which page and language: --path <address> --lang <language>.");
        const shape = await site.shape();
        if (!shape.languages.includes(lang)) return no(400, `The site's languages are ${shape.languages.join(", ")}; “${lang}” is not one of them.`);
        const page = await site.latest(path, lang);

        // One section of an existing page: replace it, put one in, or take one out.
        const ops = (["section", "insert", "remove"] as const).filter((k) => a[k] !== undefined);
        if (ops.length > 1) return no(400, "One of --section, --insert or --remove at a time.");
        if (ops.length === 1) {
          if (!page) return notFound(path, lang);
          const layout = structuredClone(page.layout ?? []);
          const op = ops[0]!;
          const n = Number(a[op]);
          const max = op === "insert" ? layout.length + 1 : layout.length;
          if (!Number.isInteger(n) || n < 1 || n > max) return no(400, `The page has ${layout.length} section(s); --${op} takes 1 to ${max}.`);
          let what: string;
          if (op === "remove") {
            if (layout.length === 1) return no(400, "A page keeps at least one section; this is its only one.");
            const [gone] = layout.splice(n - 1, 1);
            what = `${path} (${lang}), section ${n} (${String(gone?.blockType)}) removed.`;
          } else {
            const j = parseJson(a);
            if ("status" in j) return j;
            const problem = sectionProblem(j.value, shape);
            if (problem) return no(422, `Nothing was saved: ${problem}`);
            const block = j.value as Block;
            if (op === "section") {
              layout[n - 1] = block;
              what = `${path} (${lang}), section ${n} replaced (${String(block.blockType)}).`;
            } else {
              layout.splice(n - 1, 0, block);
              what = `${path} (${lang}), a ${String(block.blockType)} section put in at position ${n}.`;
            }
          }
          await site.saveDraft(lang, { layout }, page.id);
          return ok(savedText(site, what, path));
        }

        // A whole page: its words and its sections. A new page, a new language of a page, or a rewrite.
        const j = parseJson(a);
        if ("status" in j) return j;
        const given = j.value as Partial<SitePage> | null;
        if (!given || typeof given !== "object" || Array.isArray(given)) return no(400, "A page is a JSON object: {\"title\", \"summary\", \"meta\": {\"description\"}, \"layout\": [sections]}.");
        if (given.layout !== undefined) {
          if (!Array.isArray(given.layout) || !given.layout.length) return no(422, "Nothing was saved: a page needs at least one section in \"layout\".");
          for (const [i, b] of given.layout.entries()) {
            const problem = sectionProblem(b, shape);
            if (problem) return no(422, `Nothing was saved: section ${i + 1} — ${problem}`);
          }
        }
        const data: Partial<SitePage> = { title: given.title, summary: given.summary, meta: given.meta, layout: given.layout, path: given.path ? normPath(given.path) : path };
        let id = page?.id;
        let what = `${path} (${lang}) rewritten.`;
        if (!page) {
          if (!str(given.title) || !given.layout) return no(422, "Nothing was saved: a new page needs a \"title\" and a \"layout\".");
          const twin = normPath(a.sameAs);
          if (twin) {
            const other = await findPage(site, twin, "", shape.languages.filter((l) => l !== lang));
            if (!other) return no(404, `There is no page at ${twin} to add ${lang} to. \`tonoman site pages\` lists every page.`);
            id = other.page.id;
            what = `${path} (${lang}) written — the ${lang} version of ${twin}.`;
          } else what = `a new page at ${path} (${lang}).`;
        }
        await site.saveDraft(lang, data, id);
        const seo = str(given.meta?.description) || str(page?.meta?.description) ? "" : "\nIt has no description yet; the site will not publish a page without one (about 150 characters, saying what the page is).";
        return ok(savedText(site, what, data.path ?? path) + seo);
      }

      case "publish": {
        const path = normPath(a.path);
        if (!path) return no(400, "Say which page: --path <its address>.");
        // The gate. Not the agent's judgement: whoever is speaking must be an owner or admin.
        if (!MAY_PUBLISH.has(String(who.role ?? ""))) {
          return no(403, `Nothing was published. Only an owner or admin of this tenant can publish the site${who.name ? `; ${who.name} is not one` : ""}. The draft is saved — ask an owner or admin to say “publish”.`);
        }
        const shape = await site.shape();
        const found = await findPage(site, path, str(a.lang), shape.languages);
        if (!found) return notFound(path, str(a.lang));
        if ((await site.stateOf(found.page)) === "published") return ok(`Nothing is waiting: ${path} is already live exactly as it is.`);
        const live = await site.publish(found.page.id, shape.languages);
        if (!live.length) return no(409, "Nothing was published: the page has no saved version to publish.");
        return ok([`Published. Live now:`, ...live.map((l) => `- ${l.lang}: ${site.liveLink(l.path)}`)].join("\n"));
      }

      default:
        return no(404, `No command 'site ${command}'. See tonoman site --help.`);
    }
  } catch (e) {
    if (e instanceof SiteRefused) return no(e.status === 401 || e.status === 403 ? 403 : 422, `Nothing was saved or published. The site said: ${e.message}`);
    return no(502, `The site could not be reached just now, so nothing was changed (${(e as Error).message}).`);
  }
}
