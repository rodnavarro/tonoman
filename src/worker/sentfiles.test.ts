// What a person sent earlier in a conversation stays fileable in its later turns (receipt.md,
// conversation.md in Tonoman Cloud). Titles start with the rule they prove.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sentFiles } from "./sentfiles";

let dir: string;
let now = 1_800_000_000_000;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sent-"));
  now = 1_800_000_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const store = () => sentFiles(dir, () => now);
const photo = (s: string) => Buffer.from(s);

describe("the files a person sent, kept for the rest of the conversation", () => {
  it("CONVO-SENT-FILES-STAY a photo sent in one message can still be filed in the next, which has no photo", async () => {
    const s = store();
    await s.keep("g-echo", "D1", "UANA", [{ name: "receipt.jpg", bytes: photo("front") }]);
    const later = await s.recent("g-echo", "D1", "UANA");
    expect(later.map((f) => [f.name, f.bytes.toString()])).toEqual([["receipt.jpg", "front"]]);
  });

  it("CONVO-SENT-FILES-STAY they are that person's, in that conversation, with that agent: nobody else's turn gets them", async () => {
    const s = store();
    await s.keep("g-echo", "C1", "UANA", [{ name: "receipt.jpg", bytes: photo("ana's") }]);
    expect(await s.recent("g-echo", "C1", "UBEN")).toEqual([]);
    expect(await s.recent("g-echo", "C2", "UANA")).toEqual([]);
    expect(await s.recent("g-fox", "C1", "UANA")).toEqual([]);
  });

  it("CONVO-SENT-FILES-STAY a day later they are gone, and so is anything past the last few", async () => {
    const s = store();
    for (let i = 1; i <= 12; i++) {
      now += 1000;
      await s.keep("g-echo", "D1", "UANA", [{ name: `r${i}.jpg`, bytes: photo(String(i)) }]);
    }
    const kept = (await s.recent("g-echo", "D1", "UANA")).map((f) => f.name);
    expect(kept).toHaveLength(8);
    expect(kept.at(-1)).toBe("r12.jpg");
    expect(kept).not.toContain("r1.jpg");
    now += 25 * 60 * 60 * 1000;
    expect(await s.recent("g-echo", "D1", "UANA")).toEqual([]);
  });

  it("CONVO-SENT-FILES-STAY a second file with a name already kept does not replace the first", async () => {
    const s = store();
    await s.keep("g-echo", "D1", "UANA", [{ name: "receipt.jpg", bytes: photo("front") }]);
    now += 1000;
    await s.keep("g-echo", "D1", "UANA", [{ name: "receipt.jpg", bytes: photo("back") }]);
    const kept = await s.recent("g-echo", "D1", "UANA");
    expect(kept.map((f) => f.bytes.toString()).sort()).toEqual(["back", "front"]);
    expect(new Set(kept.map((f) => f.name)).size).toBe(2);
  });

  it("CONVO-SENT-FILES-STAY names that arrive over the wire cannot climb out of where they are kept", async () => {
    const s = store();
    await s.keep("../../x", "../../y", "../../z", [{ name: "../../../evil.jpg", bytes: photo("x") }]);
    const all: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name))));
    walk(dir);
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(path.resolve(f).startsWith(path.resolve(dir))).toBe(true);
    expect(fs.existsSync(path.join(dir, "..", "evil.jpg"))).toBe(false);
  });
});
