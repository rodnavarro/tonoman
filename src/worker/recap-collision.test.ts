// The Sep-10 case, reproduced: two of Celine's recordings start in the SAME MINUTE — a 9-hour
// meeting at 14:00:23 and a 2-hour one at 14:00:49. Both map to the stamp `2026-09-10-1400`.
//
// Before the fix, filing either one made the other look published, so the second was skipped in
// silence — and the poll takes the newest first, so the 9-hour meeting was the one that vanished.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publish, unpublished, type Recording } from "./recap";

const big: Recording = {
  id: "aaaaaaaa1111111111111111111111", title: "2026-09-10 10:00:23",
  startTime: Date.parse("2026-09-10T14:00:23Z"), duration: 541 * 60_000, stamp: "2026-09-10-1400",
};
const small: Recording = {
  id: "bbbbbbbb2222222222222222222222", title: "2026-09-10 10:00:49",
  startTime: Date.parse("2026-09-10T14:00:49Z"), duration: 120 * 60_000, stamp: "2026-09-10-1400",
};
const recapOf = (s: string) => ({ summary: s, highlights: [], decisions: [], followups: [] });

async function brain(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-"));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("two recordings that start in the same minute", () => {
  it("files BOTH, on distinct paths, and neither hides the other", async () => {
    const dir = await brain();
    // File the 9-hour one first (newest-first is what the poll actually does).
    await publish(dir, big, recapOf("the nine hour meeting"), "t1", "", undefined).catch(() => {});
    const afterBig = await fs.readdir(path.join(dir, "Meetings"));
    expect(afterBig).toContain("2026-09-10-1400.md");

    // THE REGRESSION: the 2-hour one must still read as unpublished.
    expect(await unpublished([small], dir, 0)).toHaveLength(1);

    await publish(dir, small, recapOf("the two hour meeting"), "t2", "", undefined).catch(() => {});
    const both = (await fs.readdir(path.join(dir, "Meetings"))).filter((n) => n.endsWith(".md")).sort();
    expect(both).toHaveLength(2);

    // Each page holds its own meeting — neither overwrote the other.
    const pages = await Promise.all(both.map((n) => fs.readFile(path.join(dir, "Meetings", n), "utf8")));
    expect(pages.some((p) => p.includes("the nine hour meeting"))).toBe(true);
    expect(pages.some((p) => p.includes("the two hour meeting"))).toBe(true);

    // And both are now settled: re-polling files neither again.
    expect(await unpublished([big, small], dir, 0)).toHaveLength(0);
  });

  it("re-running the SAME recording is still a no-op, not a second file", async () => {
    const dir = await brain();
    await publish(dir, big, recapOf("first pass"), "t1", "", undefined).catch(() => {});
    expect(await unpublished([big], dir, 0)).toHaveLength(0);
    await publish(dir, big, recapOf("first pass"), "t1", "", undefined).catch(() => {});
    const files = (await fs.readdir(path.join(dir, "Meetings"))).filter((n) => n.endsWith(".md"));
    expect(files).toHaveLength(1);
  });
});

// The Sep-15 case: Plaud renamed every id overnight (`of_` in front of the same hex). A page filed
// under the old id must still be recognised as this recording's under the new one — the same
// minute, the same instant, the same meeting — or every recording in every account is new again.
describe("the source renames its ids", () => {
  const renamed: Recording = { ...big, id: `of_${big.id}` };

  it("a page filed under the old id is still this recording's under the new one", async () => {
    const dir = await brain();
    await publish(dir, big, recapOf("filed under the old id"), "t1", "", undefined).catch(() => {});
    expect(await unpublished([renamed], dir, 0)).toHaveLength(0);
    // And the other way round: filed under the new id, asked about with the old one.
    const dir2 = await brain();
    await publish(dir2, renamed, recapOf("filed under the new id"), "t1", "", undefined).catch(() => {});
    expect(await unpublished([big], dir2, 0)).toHaveLength(0);
  });

  it("the page records the KEY, so a rename never changes what is on disk", async () => {
    const dir = await brain();
    await publish(dir, renamed, recapOf("x"), "t1", "", undefined).catch(() => {});
    const page = await fs.readFile(path.join(dir, "Meetings", "2026-09-10-1400.md"), "utf8");
    expect(page).toContain(`recording_id: ${big.id}`);
    expect(page).not.toContain("of_");
  });

  it("a rename the key cannot absorb is caught by the instant", async () => {
    const dir = await brain();
    await publish(dir, big, recapOf("x"), "t1", "", undefined).catch(() => {});
    const unrecognisable: Recording = { ...big, id: "zz-99999999-completely-different" };
    expect(await unpublished([unrecognisable], dir, 0)).toHaveLength(0);
    // ...but a genuinely different recording in the same minute is still new.
    expect(await unpublished([small], dir, 0)).toHaveLength(1);
  });

  it("a page filed under a suffix from the old id is still found", async () => {
    const dir = await brain();
    await publish(dir, small, recapOf("took the minute"), "t1", "", undefined).catch(() => {});
    await publish(dir, big, recapOf("suffixed"), "t2", "", undefined).catch(() => {});
    const names = (await fs.readdir(path.join(dir, "Meetings"))).filter((n) => n.endsWith(".md")).sort();
    expect(names).toEqual(["2026-09-10-1400-aaaaaaaa.md", "2026-09-10-1400.md"]);
    expect(await unpublished([renamed], dir, 0)).toHaveLength(0);
  });
});
