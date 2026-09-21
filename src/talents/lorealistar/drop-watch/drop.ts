// What a LOREALISTAR drop is, and how it is put into words (docs/definition/objects/drop-watch.md in
// Tonoman Cloud). PURE, and imports nothing: the Talent uses it, and so does the runtime.
//
// Every figure is the site's own. One it did not give is said to be unknown — never worked out.

const SITE = "https://us.lorealistar.com";

/** A campaign as the site gives it. Only what is used is named; a figure may be missing. */
export interface Campaign {
  id: string;
  type: string;
  name: string;
  status: string;
  start_date?: string;
  end_date?: string;
  image_url?: string;
  initial_qty?: number;
  claimed_qty?: number;
  max_claimed?: number;
  user_claimed_qty?: number;
  points_reward?: number;
  sub_brands?: { id: string; name: string }[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** PURE: a drop's figures, as the site gave them. One it did not give is null, never made up. */
export function dropFacts(c: Campaign): { id: string; name: string; brand: string | null; left: number | null; of: number | null; perPerson: number | null; starts: string | null; ends: string | null; link: string } {
  const of = num(c.initial_qty);
  const claimed = num(c.claimed_qty);
  return {
    id: c.id,
    name: c.name,
    brand: c.sub_brands?.map((b) => b.name).filter(Boolean).join(", ") || null,
    left: of === null || claimed === null ? null : Math.max(0, of - claimed),
    of,
    perPerson: num(c.max_claimed),
    starts: c.start_date ?? null,
    ends: c.end_date ?? null,
    link: `${SITE}/activities/drop/${encodeURIComponent(c.id)}`,
  };
}

/** PURE: the words for a new drop. */
export function dropLine(c: Campaign): string {
  const f = dropFacts(c);
  const stock = f.left === null ? "" : ` — ${f.left} of ${f.of} left`;
  const ends = f.ends ? `, until ${f.ends.slice(0, 10)}` : "";
  return `New LOREALISTAR drop: *${f.name}*${f.brand ? ` (${f.brand})` : ""}${stock}${ends}. ${f.link}`;
}

const slug = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "drop";

/** PURE: the page a drop gets in the brain (DROPS-A-PAGE-EACH): what it was, when it was seen, its
 *  figures then. The id is in the name, so two drops of the same product never share a page. */
export function dropPage(c: Campaign, seen: Date): { path: string; content: string } {
  const f = dropFacts(c);
  const day = seen.toISOString().slice(0, 10);
  const safeId = c.id.replace(/[^A-Za-z0-9_-]/g, "");
  const lines = [
    "---",
    "type: lorealistar-drop",
    `id: ${c.id}`,
    `seen: ${seen.toISOString()}`,
    ...(f.brand ? [`brand: ${JSON.stringify(f.brand)}`] : []),
    "---",
    "",
    `# ${f.name}`,
    "",
    `- Seen: ${seen.toISOString()}`,
    ...(f.brand ? [`- Brand: ${f.brand}`] : []),
    `- Stock when seen: ${f.left === null ? "the site did not say" : `${f.left} of ${f.of} left`}`,
    ...(f.perPerson !== null ? [`- Per person: ${f.perPerson}`] : []),
    ...(f.starts ? [`- Opens: ${f.starts}`] : []),
    ...(f.ends ? [`- Closes: ${f.ends}`] : []),
    `- Link: ${f.link}`,
    "",
  ];
  return { path: `Drops/${day}-${slug(f.name)}-${safeId}.md`, content: lines.join("\n") };
}

