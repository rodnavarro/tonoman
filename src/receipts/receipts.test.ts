// Receipts, the pure part: names, checks, the ledger row, totals, and the plan against the brain as it
// is. The oracle is the frozen examples in Tonoman Cloud's docs/definition/flows/finances/
// file-a-receipt.md; rules in objects/receipt.md. Titles start with the rule they prove.
import { describe, it, expect } from "vitest";
import { slug, checkReceipt, ledgerRow, parseCsv, totals, planReceipt, blobIdOf, LEDGER_HEADER, type CheckedReceipt, type TreeReader } from "./receipts";

const base = { vendor: "Corner Bistro", date: "2026-09-19", amount: "48.96", category: "meals", entity: "acme-llc", fileName: "IMG_1.JPG" };
const ENTITIES = ["acme-llc", "northwind-ventures-llc", "northwind-beauty-llc"];
const ok = (a: Partial<typeof base> & Record<string, unknown> = {}): CheckedReceipt => {
  const c = checkReceipt({ ...base, ...a } as never, ENTITIES);
  if (!c.ok) throw new Error(`expected ok, got: ${c.ask}`);
  return c.r;
};
const asked = (a: Record<string, unknown>) => {
  const c = checkReceipt({ ...base, ...a } as never, ENTITIES);
  expect(c.ok).toBe(false);
  return c.ok ? "" : c.ask;
};

/** A brain as it is on its remote, in memory. */
const tree = (files: Record<string, string>): TreeReader => ({
  list: async (folder) => Object.keys(files).filter((p) => p.startsWith(`${folder}/`)),
  read: async (p) => files[p] ?? null,
});

describe("the name, exactly as rn makes it", () => {
  it("RECEIPT-SAME-LAYOUT the frozen example: Corner Bistro, 2026-09-19, 48.96, meals", () => {
    const r = ok();
    expect(`${r.dir}/${r.stem}.${r.ext}`).toBe("2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg");
    expect(r.subject).toBe("finances: 2026-09-19 Corner Bistro 48.96 (meals)");
  });

  it("RECEIPT-SAME-LAYOUT accents go, punctuation goes, dots stay — Café Olé, Inc. is cafe-ole-inc.", () => {
    expect(slug("Café Olé, Inc.")).toBe("cafe-ole-inc.");
    expect(slug("Broadway Deli at Omni_Orlando")).toBe("broadway-deli-at-omni-orlando");
    expect(ok({ vendor: "Café Olé, Inc.", date: "2026-03-02", amount: "7.50" }).stem).toBe("2026-03-02_cafe-ole-inc._7.50_receipt");
  });

  it("RECEIPT-SAME-LAYOUT the extension is lowercased and the document type defaults to receipt", () => {
    const r = ok({ fileName: "scan.PDF" });
    expect(r.ext).toBe("pdf");
    expect(r.docType).toBe("receipt");
    expect(ok({ docType: "Invoice" } as never).stem).toBe("2026-09-19_corner-bistro_48.96_invoice");
  });

  it("RECEIPT-CATEGORY the category decides the class; one not on the list is refused (corrected)", () => {
    expect(ok({ category: "customer-payments" }).dir).toBe("2026/evidence/income/customer-payments/2026");
    expect(ok({ category: "card-statements" }).dir).toBe("2026/evidence/banking/card-statements/2026");
    expect(ok({ category: "1099" }).dir).toBe("2026/evidence/tax-docs/1099/2026");
    expect(ok({ category: "formation" }).dir).toBe("2026/evidence/entities/formation/2026");
    // The ones the real finances repo already files under by hand (its 2026 ledger has repairs-maintenance).
    for (const c of ["repairs-maintenance", "capital-improvements", "communications", "education", "hoa", "software-services", "storage", "utilities"]) expect(ok({ category: c }).dir).toBe(`2026/evidence/expenses/${c}/2026`);
    expect(ok({ category: "rent-income" }).dir).toBe("2026/evidence/income/rent-income/2026");
    expect(asked({ category: "snacks" })).toMatch(/not a category/);
    expect(asked({ category: "" })).toMatch(/not a category/);
  });

  it("RECEIPT-SAME-LAYOUT the year is the one named, else the document's (corrected: not always 2026)", () => {
    expect(ok({ date: "2025-11-03" }).dir).toBe("2025/evidence/expenses/meals/2025");
    expect(ok({ date: "2025-11-03" }).ledger).toBe("2025/spreadsheet/deductions_ledger.csv");
    expect(ok({ date: "2025-12-30", year: "2026" } as never).dir).toBe("2026/evidence/expenses/meals/2026");
  });
});

describe("what is asked, never guessed", () => {
  it("RECEIPT-READS-FIELDS a missing or unreadable date is asked for, never today (corrected)", () => {
    expect(asked({ date: "" })).toMatch(/date/i);
    expect(asked({ date: "19/09/2026" })).toMatch(/date/i);
  });

  it("RECEIPT-AMOUNTS dollars as printed; a refund, a zero, a comma or a foreign amount is asked about, never changed (corrected)", () => {
    expect(ok({ amount: "$48.96" }).amount).toBe("48.96");
    expect(ok({ amount: "7.50" }).amount).toBe("7.50");
    expect(asked({ amount: "-48.96" })).toMatch(/refund/i);
    expect(asked({ amount: "0" })).toMatch(/zero/i);
    expect(asked({ amount: "0.00" })).toMatch(/zero/i);
    expect(asked({ amount: "48,96" })).toMatch(/dollars/i);
    expect(asked({ amount: "€48.96" })).toMatch(/dollars/i);
  });

  it("RECEIPT-AMOUNTS a refund is a refund however it is dressed: a positive amount with the document type `refund` (what the agent tried, live) is asked about, not filed as an expense", () => {
    for (const docType of ["refund", "Refund", "credit", "credit note", "credit-memo", "return", "chargeback", "reversal"]) expect(asked({ docType })).toMatch(/refund/i);
    expect(ok({ docType: "invoice" } as never).docType).toBe("invoice");
  });

  it("RECEIPT-ENTITY-ALWAYS no entity, no filing; one not the tenant's is refused", () => {
    expect(asked({ entity: "" })).toMatch(/entity/i);
    expect(checkReceipt({ ...base, entity: "umbrella-llc" } as never, ["acme-llc", "northwind-ventures-llc"]).ok).toBe(false);
    expect(checkReceipt({ ...base } as never, ["acme-llc"]).ok).toBe(true);
  });

  it("RECEIPT-DOCUMENTS a photo or a PDF; anything else is refused", () => {
    for (const f of ["a.jpg", "a.jpeg", "a.png", "a.heic", "a.pdf"]) expect(ok({ fileName: f }).ext).toBe(f.split(".")[1]);
    expect(asked({ fileName: "a.docx" })).toMatch(/JPEG, PNG, HEIC or PDF/);
  });
});

describe("the ledger", () => {
  it("RECEIPT-LEDGER a row is captured, category, amount, vendor as written, entity, evidence path, note, two empty columns", () => {
    const r = ok({ note: "Acme LLC — business breakfast; ordinary and necessary" } as never);
    expect(ledgerRow(r, "2026/evidence/expenses/meals/2026/x.jpg")).toBe(
      "captured,meals,48.96,Corner Bistro,acme-llc,2026/evidence/expenses/meals/2026/x.jpg,Acme LLC — business breakfast; ordinary and necessary,,",
    );
  });

  it("RECEIPT-LEDGER a comma, a quote or a line break is quoted, CSV-style — the frozen example", () => {
    const r = ok({ note: 'Lunch, with "Ana"' } as never);
    expect(ledgerRow(r, "p")).toContain(',"Lunch, with ""Ana""",,');
  });

  it("RECEIPT-TOTALS counted as CSV: a quoted comma or line break does not split a row (corrected)", () => {
    const ledger = `${LEDGER_HEADER}\ncaptured,meals,48.96,Corner Bistro,acme-llc,p1,"Lunch, with Ana",,\ncaptured,meals,20.00,Starbucks,,p2,"two\nlines",,\ncaptured,travel,100.5,Delta,acme-llc,p3,,,\n`;
    expect(parseCsv(ledger)).toHaveLength(4);
    const t = totals(ledger);
    expect(t.count).toBe(3);
    expect(t.total).toBe(169.46);
    expect(t.byCategory.meals).toEqual({ count: 2, amount: 68.96 });
  });
});

describe("filing against the brain as it is", () => {
  const bytes = Buffer.from("jpeg");

  it("RECEIPT-EVIDENCE-FIRST the file and its row are written together, and the row names the file", async () => {
    const p = await planReceipt(ok(), bytes, tree({ "2026/spreadsheet/deductions_ledger.csv": `${LEDGER_HEADER}\n` }));
    if (!("write" in p)) throw new Error("expected a write");
    expect(p.write.map((w) => w.path)).toEqual(["2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg", "2026/spreadsheet/deductions_ledger.csv"]);
    expect(String(p.write[1]!.content)).toContain(",2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg,");
  });

  it("RECEIPT-LEDGER a new year's ledger starts with the header", async () => {
    const p = await planReceipt(ok({ date: "2027-01-05" }), bytes, tree({}));
    if (!("write" in p)) throw new Error("expected a write");
    expect(String(p.write[1]!.content).split("\n")[0]).toBe(LEDGER_HEADER);
  });

  it("RECEIPT-NO-DOUBLE the same date, vendor, amount and type anywhere in the year's evidence is already on file, whatever its category or extension", async () => {
    const filed = "2026/evidence/expenses/travel/2026/2026-09-19_corner-bistro_48.96_receipt.png";
    const p = await planReceipt(ok(), bytes, tree({ [filed]: "x" }));
    expect(p).toEqual({ nothing: expect.objectContaining({ status: "duplicate", evidence: filed }) });
  });

  it("RECEIPT-EXTRA-PHOTOS more photos of a filed payment are kept beside the first as _2, _3, with no new row", async () => {
    const first = "2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg";
    const files = { [first]: "x", [first.replace(".jpg", "_2.jpg")]: "x", "2026/spreadsheet/deductions_ledger.csv": `${LEDGER_HEADER}\nrow\n` };
    const p = await planReceipt(ok({ extra: true } as never), bytes, tree(files));
    if (!("write" in p)) throw new Error("expected a write");
    expect(p.write.map((w) => w.path)).toEqual([first.replace(".jpg", "_3.jpg")]);
  });

  it("RECEIPT-NO-DOUBLE a filed `receipt.other` is not this `receipt`: the name is compared whole, less its one extension", async () => {
    const other = "2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.other.pdf";
    const p = await planReceipt(ok(), bytes, tree({ [other]: "x" }));
    expect("write" in p).toBe(true);
    const extra = await planReceipt(ok({ extra: true } as never), bytes, tree({ [other]: "x" }));
    expect(extra).toEqual({ nothing: expect.objectContaining({ status: "no-original" }) });
  });

  it("RECEIPT-EXTRA-PHOTOS the same photo sent again (a retry after a lost answer) is already kept: no _3 of the same bytes", async () => {
    const first = "2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg";
    const second = first.replace(".jpg", "_2.jpg");
    const t: TreeReader = { ...tree({ [first]: "x", [second]: "y" }), blobId: async (p) => (p === second ? blobIdOf(bytes) : "other") };
    const p = await planReceipt(ok({ extra: true } as never), bytes, t);
    expect(p).toEqual({ nothing: expect.objectContaining({ status: "extra", evidence: second }) });
  });

  it("RECEIPT-LEDGER a ledger that would swallow the new row — a quote never closed, or another file's header — is reported and left as it is", async () => {
    const at = "2026/spreadsheet/deductions_ledger.csv";
    for (const broken of [`${LEDGER_HEADER}\ncaptured,meals,1.00,A,acme-llc,p,"never closed,,\n`, "date,vendor,amount\n2026-01-01,A,1.00\n"]) {
      const p = await planReceipt(ok(), bytes, tree({ [at]: broken }));
      expect(p).toEqual({ nothing: expect.objectContaining({ status: "ledger-broken" }) });
    }
  });

  it("RECEIPT-LEDGER an old row with a comma nobody quoted (the real 2026 ledger has one) does not stop a filing", async () => {
    const at = "2026/spreadsheet/deductions_ledger.csv";
    const p = await planReceipt(ok(), bytes, tree({ [at]: `${LEDGER_HEADER}\ncaptured,meals,12.00,Deli, Inc,acme-llc,p,,,\n` }));
    expect("write" in p).toBe(true);
  });

  it("RECEIPT-LEDGER a ledger that starts with a byte-order mark is the same ledger", async () => {
    const at = "2026/spreadsheet/deductions_ledger.csv";
    const p = await planReceipt(ok(), bytes, tree({ [at]: `﻿${LEDGER_HEADER}\ncaptured,meals,1.00,A,acme-llc,p,,,\n` }));
    expect("write" in p).toBe(true);
    expect(totals(`﻿${LEDGER_HEADER}\ncaptured,meals,1.00,A,acme-llc,p,,,\n`)).toMatchObject({ count: 1, total: 1 });
  });
});

describe("what Astra's review found (each was accepted before)", () => {
  it("RECEIPT-READS-FIELDS a date that does not exist is asked about: 2026-02-31 is not March 3", () => {
    expect(asked({ date: "2026-02-31" })).toMatch(/date/i);
    expect(asked({ date: "2026-13-01" })).toMatch(/date/i);
    expect(ok({ date: "2028-02-29" }).date).toBe("2028-02-29");
  });

  it("RECEIPT-AMOUNTS dollars and cents: three decimals, or a number too long to be money, is asked about", () => {
    expect(asked({ amount: "0.005" })).toMatch(/dollars/i);
    expect(asked({ amount: "48.965" })).toMatch(/dollars/i);
    expect(asked({ amount: "12345678901234567890" })).toMatch(/dollars/i);
    expect(ok({ amount: "48.9" }).amount).toBe("48.9");
    expect(ok({ amount: "1200" }).amount).toBe("1200");
  });

  it("RECEIPT-CATEGORY a word JavaScript happens to know is not a category", () => {
    for (const c of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(asked({ category: c })).toMatch(/not a category/);
  });

  it("RECEIPT-EXTRA-PHOTOS another photo of a filed payment needs only what names the payment — its date, vendor and amount — not an entity or a category: it adds no row", () => {
    const c = checkReceipt({ vendor: "Corner Bistro", date: "2026-09-19", amount: "48.96", category: "", entity: "", fileName: "back.jpg", extra: true }, ENTITIES);
    expect(c.ok).toBe(true);
    expect(c.ok && c.r.stem).toBe("2026-09-19_corner-bistro_48.96_receipt");
    expect(c.ok && c.r.subject).toBe("finances: 2026-09-19 Corner Bistro 48.96 (another photo)");
    // A new filing still needs both.
    expect(checkReceipt({ vendor: "Corner Bistro", date: "2026-09-19", amount: "48.96", category: "", entity: "", fileName: "back.jpg" }, ENTITIES).ok).toBe(false);
  });

  it("RECEIPT-ENTITY-ALWAYS with no entities set for the tenant nothing is filed: the list is what makes an entity real", () => {
    const c = checkReceipt({ ...base } as never, []);
    expect(c.ok).toBe(false);
    expect(c.ok ? "" : c.ask).toMatch(/entities are not set/i);
  });

  it("RECEIPT-ENTITY-ALWAYS entities are matched as they are written in the settings, whatever their case or spacing", () => {
    expect(checkReceipt({ ...base, entity: "Acme LLC" } as never, [" Acme-LLC "]).ok).toBe(true);
  });

  it("RECEIPT-TOTALS cents are counted as cents: the categories always add up to the total", () => {
    const rows = Array.from({ length: 3 }, (_, i) => `captured,meals,0.10,V${i},acme-llc,p${i},,,`).join("\n");
    const t = totals(`${LEDGER_HEADER}\n${rows}\ncaptured,travel,0.20,D,acme-llc,p,,,\n`);
    expect(t.byCategory.meals!.amount).toBe(0.3);
    expect(t.total).toBe(0.5);
    expect(Object.values(t.byCategory).reduce((n, c) => n + Math.round(c.amount * 100), 0)).toBe(Math.round(t.total * 100));
  });

  it("RECEIPT-TOTALS an amount someone typed by hand that is not money (48.96USD) is counted as a row and said to be unreadable, never guessed", () => {
    const t = totals(`${LEDGER_HEADER}\ncaptured,meals,48.96USD,A,acme-llc,p,,,\ncaptured,meals,10.00,B,acme-llc,q,,,\n`);
    expect(t).toMatchObject({ count: 2, total: 10, unreadable: 1 });
  });

  it("RECEIPT-TOTALS a category JavaScript happens to know is a category like any other", () => {
    const t = totals(`${LEDGER_HEADER}\ncaptured,constructor,5.00,A,acme-llc,p,,,\n`);
    expect(t.byCategory["constructor"]).toEqual({ count: 1, amount: 5 });
  });
});
