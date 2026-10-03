// A website's content, as the Website Talent reaches it (website.md in Tonoman Cloud): the pages of a
// site whose content management is Payload — pages with an address per language, sections, and a
// draft and a published version. Everything here is an HTTP call to the site's own content API with
// the agent's key; the site decides what that key may do.
//
// Two rules live here rather than in the commands, so no command can get them wrong:
//   - `saveDraft` ALWAYS saves a draft (SITE-CHANGES-ARE-DRAFTS). There is no flag to publish.
//   - `publish` sends no content: it makes the latest saved draft live, exactly as it is
//     (SITE-PUBLISH-IS-WHAT-WAS-PREVIEWED).

export interface SiteConnection {
  /** Where visitors find the site, and where links the agent hands out point. */
  url: string;
  /** Its content API. `<url>/api` when not given. */
  api?: string;
  apiKey: string;
  previewSecret: string;
}

export interface SitePage {
  id: string | number;
  title?: string | null;
  path?: string | null;
  summary?: string | null;
  meta?: { titleTag?: string | null; description?: string | null; image?: string | null; noindex?: boolean | null } | null;
  layout?: Record<string, unknown>[] | null;
  _status?: "draft" | "published" | null;
  updatedAt?: string;
}

export type PageState = "published" | "draft" | "changes";

export interface PageListing {
  id: string | number;
  state: PageState;
  /** By language: the page's address and title there. A language the page is not written in is absent. */
  in: Record<string, { path: string; title: string }>;
}

export interface FieldInfo {
  name: string;
  type: string;
  required?: true;
  options?: string[];
  about?: string;
  fields?: FieldInfo[];
}

export interface SiteShape {
  languages: string[];
  sections: { blockType: string; label: string; fields: FieldInfo[] }[];
}

/** The site said no, in its own words (SITE-REFUSALS-ARE-RELAYED). */
export class SiteRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What of a page is its content — the fields a save and a publish carry. */
const CONTENT = ["title", "path", "summary", "meta", "layout"] as const;

type Localized<T> = Record<string, T | null | undefined> | null | undefined;

export function payloadSite(conn: SiteConnection, fetchImpl: typeof fetch = fetch) {
  const site = conn.url.replace(/\/+$/, "");
  const api = (conn.api || `${site}/api`).replace(/\/+$/, "");

  async function call<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetchImpl(`${api}${pathname}`, {
        method,
        headers: { authorization: `users API-Key ${conn.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`the site could not be reached (${(e as Error).message})`);
    }
    const text = await r.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        const said = saidBy(parsed);
        throw new SiteRefused(said || (r.status === 401 ? "the site did not accept the agent's key" : "the site does not allow the agent to do that"), r.status);
      }
      throw new SiteRefused(saidBy(parsed) || `the site answered ${r.status}`, r.status);
    }
    return parsed as T;
  }

  /** The site's own words for a refusal: its message, and each field's problem. */
  function saidBy(parsed: unknown): string {
    const errors = (parsed as { errors?: { message?: string; data?: { errors?: { path?: string; message?: string }[] } }[] } | undefined)?.errors;
    if (!Array.isArray(errors) || !errors.length) return "";
    return errors
      .flatMap((e) => {
        const fields = (e.data?.errors ?? []).map((f) => `${f.path ?? "a field"}: ${f.message ?? "is not valid"}`);
        return fields.length ? fields : [e.message ?? ""];
      })
      .filter(Boolean)
      .join("; ");
  }

  const q = (params: Record<string, string>) =>
    Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k).replace(/%5B/g, "[").replace(/%5D/g, "]")}=${encodeURIComponent(v)}`)
      .join("&");

  /** What the site offers: its languages and the kinds of section a page can be made of. */
  async function shape(): Promise<SiteShape> {
    const r = await call<{ languages?: string[]; sections?: SiteShape["sections"] }>("GET", "/pages/sections");
    return { languages: r.languages?.length ? r.languages : ["en"], sections: r.sections ?? [] };
  }

  /** The page at this address in this language — its latest saved version, draft or not — or null. */
  async function latest(path: string, lang: string): Promise<SitePage | null> {
    const r = await call<{ docs: SitePage[] }>("GET", `/pages?${q({ locale: lang, draft: "true", depth: "0", limit: "1", "where[path][equals]": path })}`);
    return r.docs[0] ?? null;
  }

  /** The page at this address as visitors see it now — its published version — or null. */
  async function published(path: string, lang: string): Promise<SitePage | null> {
    const r = await call<{ docs: SitePage[] }>("GET", `/pages?${q({ locale: lang, depth: "0", limit: "1", "where[path][equals]": path, "where[_status][equals]": "published" })}`);
    return r.docs[0] ?? null;
  }

  /** The same page in another language (its latest version), or null when it is not written there. */
  async function latestById(id: string | number, lang: string): Promise<SitePage | null> {
    const p = await call<SitePage>("GET", `/pages/${encodeURIComponent(String(id))}?${q({ locale: lang, draft: "true", depth: "0" })}`).catch((e) => {
      if (e instanceof SiteRefused && e.status === 404) return null;
      throw e;
    });
    return p && p.path ? p : null;
  }

  /** Is a version of this page live? */
  async function isPublished(id: string | number): Promise<boolean> {
    const p = await call<SitePage>("GET", `/pages/${encodeURIComponent(String(id))}?${q({ depth: "0", "select[_status]": "true" })}`).catch(() => null);
    return p?._status === "published";
  }

  async function stateOf(page: SitePage): Promise<PageState> {
    if (page._status === "published") return "published";
    return (await isPublished(page.id)) ? "changes" : "draft";
  }

  return {
    site,
    shape,
    latest,
    published,
    latestById,
    stateOf,

    /** Every page, with its address and title in each language and whether it is live (SITE-LISTS-PAGES). */
    async pages(): Promise<PageListing[]> {
      type Row = { id: string | number; title?: Localized<string>; path?: Localized<string>; _status?: string };
      const [all, live] = await Promise.all([
        // `_status` is asked for by name: a `select` returns only what it lists, and a page whose
        // status did not come back would read as "changes waiting".
        call<{ docs: Row[] }>("GET", `/pages?${q({ locale: "all", draft: "true", depth: "0", limit: "500", "select[title]": "true", "select[path]": "true", "select[_status]": "true" })}`),
        call<{ docs: { id: string | number }[] }>("GET", `/pages?${q({ locale: "all", depth: "0", limit: "500", "where[_status][equals]": "published", "select[path]": "true" })}`),
      ]);
      const published = new Set(live.docs.map((d) => String(d.id)));
      return all.docs.map((d) => {
        const here: PageListing["in"] = {};
        for (const [lang, path] of Object.entries(d.path ?? {})) if (path) here[lang] = { path, title: d.title?.[lang] ?? "" };
        const state: PageState = d._status === "published" ? "published" : published.has(String(d.id)) ? "changes" : "draft";
        return { id: d.id, state, in: here };
      });
    },

    /** Save this language's content as a DRAFT — a new page when `id` is not given. Never publishes. */
    async saveDraft(lang: string, data: Partial<SitePage>, id?: string | number): Promise<SitePage> {
      const body: Record<string, unknown> = { _status: "draft" };
      for (const k of CONTENT) if (data[k] !== undefined) body[k] = data[k];
      const r =
        id === undefined
          ? await call<{ doc: SitePage }>("POST", `/pages?${q({ locale: lang, draft: "true", depth: "0" })}`, body)
          : await call<{ doc: SitePage }>("PATCH", `/pages/${encodeURIComponent(String(id))}?${q({ locale: lang, draft: "true", depth: "0" })}`, body);
      return r.doc;
    },

    /** Publish the page's latest draft — the same words the preview showed. A page's status is the
     *  whole page's: one request makes the latest saved version live in every language it is
     *  written in. Answers where each language now lives. */
    async publish(id: string | number, langs: string[]): Promise<{ lang: string; path: string }[]> {
      await call<{ doc: SitePage }>("PATCH", `/pages/${encodeURIComponent(String(id))}?${q({ locale: langs[0] ?? "en", depth: "0" })}`, { _status: "published" });
      const live: { lang: string; path: string }[] = [];
      for (const lang of langs) {
        const now = await latestById(id, lang);
        if (now?.path) live.push({ lang, path: now.path });
      }
      return live;
    },

    /** The draft, on the real site, for whoever holds the link (SITE-PREVIEW-LINK). */
    previewLink: (path: string): string => `${site}${path === "/" ? "/" : path}?preview=${encodeURIComponent(conn.previewSecret)}`,
    liveLink: (path: string): string => `${site}${path === "/" ? "/" : path}`,
  };
}

export type PayloadSite = ReturnType<typeof payloadSite>;
