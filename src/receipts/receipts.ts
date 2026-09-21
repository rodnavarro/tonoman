// Receipts: a finance document filed into a finances brain as evidence plus one ledger row
// (docs/definition/objects/receipt.md in Tonoman Cloud; frozen examples in flows/finances/file-a-receipt.md).
//
// The layout is what the Teams Sapien's `rn finance receipt` wrote (tonoman-config lib/rn/finance.js,
// util.js), so both agents see each other's filings — the name is the dedup key. Where the definition
// marks a correction (entity required, no silent amount changes, unknown categories refused, the
// document's year, CSV-aware totals) this follows the definition, not the CLI.
//
// Everything here but `planReceipt` is pure. The plan runs inside every push attempt against the
// brain as it is on its remote, so a duplicate, an extra photo's number and the ledger's last row are
// always worked out from the latest state — never from a copy that someone else has since changed.

import { createHash } from "node:crypto";

/** rn's slug, byte for byte (util.js): the name both agents must agree on. Dots stay. */
export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** rn's extension: without the dot, lowercased; "" if none. */
export function ext(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** The category decides the evidence class (RECEIPT-CATEGORY). A category not here is refused. Looked
 *  up with `Object.hasOwn`: `constructor` is a word JavaScript knows, not a category. */
export const CATEGORY_CLASS: Readonly<Record<string, string>> = {
  meals: "expenses", travel: "expenses", vehicle: "expenses", "software-saas": "expenses",
  contractors: "expenses", equipment: "expenses", office: "expenses", marketing: "expenses",
  "professional-services": "expenses", "bank-fees": "expenses", insurance: "expenses",
  "training-education": "expenses", "licenses-permits": "expenses", "tax-payments-fees": "expenses",
  "memberships-registrations": "expenses",
  // What the finances repo already files under by hand, beyond rn's own list.
  "repairs-maintenance": "expenses", "capital-improvements": "expenses", communications: "expenses", education: "expenses",
  hoa: "expenses", "software-services": "expenses", storage: "expenses", utilities: "expenses",
  "customer-payments": "income", "platform-payouts": "income", "interest-other-income": "income", "rent-income": "income",
  statements: "banking", "card-statements": "banking",
  "1099": "tax-docs", w2: "tax-docs", k1: "tax-docs", estimates: "tax-docs", returns: "tax-docs",
  formation: "entities", compliance: "entities",
};

export const LEDGER_HEADER = "status,category,amount,merchant_or_source,property_or_business_link,evidence_path,treatment_note,confidence,notes";

/** Documents a receipt may be (RECEIPT-DOCUMENTS). */
export const DOCUMENT_TYPES: ReadonlySet<string> = new Set(["jpg", "jpeg", "png", "heic", "pdf"]);
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** PURE: why these bytes cannot be filed under this name, or null (RECEIPT-DOCUMENTS). A file is what
 *  its first bytes say, not what it is called; an empty one, one that is something else, and a PDF
 *  that needs a password are refused before anything is written. */
export function documentTrouble(name: string, bytes: Buffer): string | null {
  const e = ext(name);
  if (!DOCUMENT_TYPES.has(e)) return `A .${e || "?"} file is not a document that can be filed (JPEG, PNG, HEIC or PDF).`;
  if (bytes.length === 0) return "That file is empty.";
  if (bytes.length > MAX_DOCUMENT_BYTES) return "That file is over 25 MB.";
  const starts = (...b: number[]) => b.every((v, i) => bytes[i] === v);
  const is =
    e === "jpg" || e === "jpeg" ? starts(0xff, 0xd8, 0xff)
    : e === "png" ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    : e === "pdf" ? bytes.subarray(0, 1024).includes("%PDF-")
    : /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(bytes.subarray(8, 12).toString("latin1")) && bytes.subarray(4, 8).toString("latin1") === "ftyp";
  if (!is) return `That file is called .${e} but is not one, or it is damaged. Ask the person to send it again.`;
  // An encrypted PDF names its /Encrypt dictionary in the trailer, which is never itself encrypted.
  if (e === "pdf" && bytes.includes("/Encrypt")) return "That PDF needs a password, so it cannot be read or filed. Ask the person for one without a password.";
  return null;
}

export interface ReceiptArgs {
  vendor: string;
  date: string;
  amount: string;
  category: string;
  entity: string;
  docType?: string;
  year?: string;
  note?: string;
  /** Another photo of a payment already filed (RECEIPT-EXTRA-PHOTOS). */
  extra?: boolean;
  /** The file's own name, for its extension. */
  fileName: string;
}

export interface CheckedReceipt {
  vendor: string;
  date: string;
  amount: string;
  category: string;
  cls: string;
  entity: string;
  docType: string;
  year: string;
  note: string;
  ext: string;
  extra: boolean;
  stem: string;
  dir: string;
  ledger: string;
  subject: string;
}

export type Checked = { ok: true; r: CheckedReceipt } | { ok: false; ask: string };

/** PURE: a date that exists. `Date.parse` turns 2026-02-31 into March 3; the calendar does not. */
function realDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** PURE: every field checked before anything is written. A refusal says what to ask the person.
 *  `entities` is the tenant's own list from the Talent's settings: with none set nothing is filed,
 *  because the list is what makes an entity real (RECEIPT-ENTITY-ALWAYS). */
export function checkReceipt(a: ReceiptArgs, entities: string[]): Checked {
  const vendor = (a.vendor ?? "").trim();
  if (!vendor || !slug(vendor)) return { ok: false, ask: "The vendor is missing. Ask the person who it was paid to." };
  const date = (a.date ?? "").trim();
  // A missing date is asked for, never "today" (RECEIPT-READS-FIELDS).
  if (!realDate(date)) {
    return { ok: false, ask: "The date is missing or not YYYY-MM-DD. Ask the person for the date on the document." };
  }
  // US dollars as printed, digits and a dot (D-RECEIPT-AMOUNTS). A leading $ is the same dollars.
  const raw = (a.amount ?? "").trim().replace(/^\$\s*/, "");
  if (/^-/.test(raw) || /^\(.*\)$/.test(raw)) return { ok: false, ask: "That is a refund (a negative amount). Refunds are not filed until the person says how; ask them." };
  // Dollars and cents, and no longer than money is: three decimals or twenty digits is not an amount.
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, ask: `"${a.amount}" is not a US-dollar amount written with digits and a dot. Ask the person for the amount in dollars (a foreign amount is converted by them).` };
  }
  if (Number(raw) === 0) return { ok: false, ask: "The amount is zero. A zero receipt is not filed until the person says how; ask them." };
  // Another photo of a filed payment adds no row: it is found by its date, vendor and amount, and
  // kept beside the first wherever that is, so it needs no category and no entity.
  const extra = !!a.extra;
  const category = slug(a.category ?? "");
  const cls = Object.hasOwn(CATEGORY_CLASS, category) ? CATEGORY_CLASS[category] : extra ? "" : undefined;
  if (cls === undefined) return { ok: false, ask: `"${a.category}" is not a category the ledger uses. Pick one of: ${Object.keys(CATEGORY_CLASS).join(", ")} — or ask the person.` };
  const entity = slug(a.entity ?? "");
  if (!entity && !extra) return { ok: false, ask: "Every receipt belongs to one legal entity. Ask the person which one." };
  const known = entities.map(slug).filter(Boolean);
  if (entity || !extra) {
    if (!known.length) return { ok: false, ask: "This tenant's legal entities are not set in the Receipts settings, so nothing can be filed yet. Tell the person to set them in the Hub (the agent's Receipts Talent)." };
    if (!known.includes(entity)) return { ok: false, ask: `"${a.entity}" is not one of this tenant's entities (${known.join(", ")}). Ask the person which one.` };
  }
  const e = ext(a.fileName);
  if (!DOCUMENT_TYPES.has(e)) return { ok: false, ask: `A .${e || "?"} file is not a document that can be filed (JPEG, PNG, HEIC or PDF).` };
  const docType = slug(a.docType?.trim() || "receipt") || "receipt";
  // A refund is a refund however it is dressed. Asked live to "file this refund", the agent filed a
  // positive amount with the document type `refund`: money coming back, booked as money spent.
  if (/^(refunds?|credits?|credit-(note|memo)|returns?|chargebacks?|reversals?)$/.test(docType)) {
    return { ok: false, ask: "That is a refund. Refunds are not filed until the person says how, and I cannot file one yet: tell them it goes into the ledger by hand, as a negative amount in the same category." };
  }
  const year = (a.year ?? "").trim() || date.slice(0, 4);
  if (!/^\d{4}$/.test(year)) return { ok: false, ask: "The tax year must be four digits." };
  const stem = `${date}_${slug(vendor)}_${raw}_${docType}`;
  return {
    ok: true,
    r: {
      vendor, date, amount: raw, category, cls, entity, docType, year,
      note: (a.note ?? "").trim(),
      ext: e,
      extra: !!a.extra,
      stem,
      dir: `${year}/evidence/${cls}/${category}/${year}`,
      ledger: `${year}/spreadsheet/deductions_ledger.csv`,
      subject: `finances: ${date} ${vendor} ${raw} (${extra ? "another photo" : category})`,
    },
  };
}

/** PURE: one CSV cell, quoted when it holds a comma, a quote or a line break. */
export function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** PURE: the ledger row for a filing (RECEIPT-LEDGER). */
export function ledgerRow(r: CheckedReceipt, evidencePath: string): string {
  return ["captured", r.category, r.amount, r.vendor, r.entity, evidencePath, r.note, "", ""].map(csvCell).join(",");
}

/** PURE: CSV records, honouring quotes (a quoted comma or line break stays inside its cell). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** PURE: text without a leading byte-order mark, which a spreadsheet adds and a header check trips on. */
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** PURE: an amount in cents, or null when it is not money (`48.96USD`, typed by hand). Never guessed. */
function cents(v: string): number | null {
  const m = /^\$?\s*(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : null;
}

/** PURE: the year's count and totals by category, from the ledger (RECEIPT-TOTALS). Counted in cents,
 *  so the categories always add up to the total; a row whose amount is not money is counted and said
 *  to be unreadable. */
export function totals(ledgerText: string): { count: number; total: number; unreadable: number; byCategory: Record<string, { count: number; amount: number }> } {
  const rows = parseCsv(withoutBom(ledgerText));
  const by = new Map<string, { count: number; cents: number }>();
  let count = 0;
  let total = 0;
  let unreadable = 0;
  for (const cols of rows.slice(rows[0]?.[0] === "status" ? 1 : 0)) {
    const cat = (cols[1] || "uncategorized").trim();
    const c = cents(cols[2] ?? "");
    if (c === null) unreadable++;
    const at = by.get(cat) ?? { count: 0, cents: 0 };
    by.set(cat, { count: at.count + 1, cents: at.cents + (c ?? 0) });
    count++;
    total += c ?? 0;
  }
  // A plain object with no prototype: `constructor` is a category like any other.
  const byCategory: Record<string, { count: number; amount: number }> = Object.create(null);
  for (const [cat, v] of by) byCategory[cat] = { count: v.count, amount: v.cents / 100 };
  return { count, total: total / 100, unreadable, byCategory };
}

/** PURE: why a new row cannot safely be added to this ledger, or null. Only what would swallow the
 *  row is refused — a quote never closed, or another file's header. An old row with a comma nobody
 *  quoted is left alone: the real ledger has one, and filing must go on. */
export function ledgerTrouble(text: string): string | null {
  const t = withoutBom(text);
  if (!t.trim()) return null;
  if (t.split(/\r?\n/, 1)[0]!.trim() !== LEDGER_HEADER) return "its first line is not the ledger's header";
  let q = false;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '"') continue;
    if (q && t[i + 1] === '"') i++;
    else q = !q;
  }
  return q ? "a quote in it is never closed, so a new row would be read as part of that note" : null;
}

/** PURE: git's own name for these bytes, to tell whether a file already kept is this same photo. */
export function blobIdOf(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** What the plan can see of the brain as it is on its remote. */
export interface TreeReader {
  /** Every file under a folder, as repo-relative paths. */
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** Git's name for a file's bytes, when the reader can say. */
  blobId?(path: string): Promise<string | null>;
}

export type Plan =
  | { write: { path: string; content: string | Buffer }[]; outcome: FiledOutcome }
  | { nothing: FiledOutcome };

export type FiledOutcome =
  | { status: "filed"; evidence: string; ledger: string; r: CheckedReceipt }
  | { status: "extra"; evidence: string; of: string; r: CheckedReceipt }
  | { status: "duplicate"; evidence: string; r: CheckedReceipt }
  | { status: "no-original"; r: CheckedReceipt }
  | { status: "ledger-broken"; ledger: string; why: string; r: CheckedReceipt };

/** The filing, worked out from the brain as it is now (runs inside every push attempt). */
export async function planReceipt(r: CheckedReceipt, bytes: Buffer, tree: TreeReader): Promise<Plan> {
  const name = (p: string) => p.split("/").pop() ?? "";
  // Less its ONE extension, compared whole: `…_receipt.other.pdf` is a different document type.
  const bare = (p: string) => name(p).replace(/\.[^.]*$/, "");
  const existing = (await tree.list(`${r.year}/evidence`)).find((p) => name(p) === r.stem || bare(p) === r.stem) ?? null;
  if (r.extra) {
    if (!existing) return { nothing: { status: "no-original", r } };
    const folder = existing.split("/").slice(0, -1).join("/");
    const firstStem = name(existing).replace(/\.[^.]*$/, "");
    const beside = await tree.list(folder);
    // The same photo sent again — a retry after an answer was lost — is already kept.
    if (tree.blobId) {
      const mine = blobIdOf(bytes);
      for (const p of beside.filter((f) => /_\d+$/.test(bare(f)) && bare(f).replace(/_\d+$/, "") === firstStem)) {
        if ((await tree.blobId(p)) === mine) return { nothing: { status: "extra", evidence: p, of: existing, r } };
      }
    }
    const taken = new Set(beside.map(bare));
    let n = 2;
    while (taken.has(`${firstStem}_${n}`)) n++;
    const evidence = `${folder}/${firstStem}_${n}${r.ext ? `.${r.ext}` : ""}`;
    return { write: [{ path: evidence, content: bytes }], outcome: { status: "extra", evidence, of: existing, r } };
  }
  if (existing) return { nothing: { status: "duplicate", evidence: existing, r } };
  const evidence = `${r.dir}/${r.stem}${r.ext ? `.${r.ext}` : ""}`;
  const prior = await tree.read(r.ledger);
  const trouble = prior === null ? null : ledgerTrouble(prior);
  if (trouble) return { nothing: { status: "ledger-broken", ledger: r.ledger, why: trouble, r } };
  const base = prior === null || !prior.trim() ? `${LEDGER_HEADER}\n` : prior.endsWith("\n") ? prior : `${prior}\n`;
  // Evidence first (RECEIPT-EVIDENCE-FIRST): both land in one commit, and the row names the file.
  return {
    write: [
      { path: evidence, content: bytes },
      { path: r.ledger, content: `${base}${ledgerRow(r, evidence)}\n` },
    ],
    outcome: { status: "filed", evidence, ledger: r.ledger, r },
  };
}

/** PURE: what the agent reports (RECEIPT-REPORT, RECEIPT-NUMBERS-FROM-FILING). */
export function reportOf(o: FiledOutcome): string {
  const r = o.r;
  if (o.status === "duplicate") return `Already on file — nothing written: ${o.evidence}`;
  if (o.status === "ledger-broken") return `Not filed — nothing written. The ledger ${o.ledger} needs a person to fix it first: ${o.why}.`;
  if (o.status === "no-original") return `No filed receipt matches ${r.date} ${r.vendor} ${r.amount} (${r.docType}); file it first, then add the extra photo.`;
  if (o.status === "extra") return `Kept beside the first as another photo of the same payment (no new row): ${o.evidence}`;
  return `Filed: ${r.vendor} — $${r.amount} — ${r.category} — ${r.date} → ${r.entity} → ${r.dir.split("/").slice(0, 4).join("/")}\nevidence: ${o.evidence}\nledger: ${o.ledger}`;
}
