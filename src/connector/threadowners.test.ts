// The worker's record of which agent last answered each thread (CONVO-WHO-IS-ADDRESSED): bounded,
// and kept across a restart.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { threadOwners } from "./threadowners";

describe("who answered a thread last", () => {
  it("CONVO-WHO-IS-ADDRESSED the last agent to answer wins, and the record survives a restart", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "owners-")), "thread-owners.json");
    const a = threadOwners({ file });
    a.set("C1", "1.0", "UBOT");
    a.set("C1", "1.0", "UGOLF");
    await a.flush();
    expect(threadOwners({ file }).get("C1", "1.0")).toBe("UGOLF");
  });

  it("CONVO-WHO-IS-ADDRESSED the record is bounded: the threads answered longest ago are forgotten first", () => {
    const o = threadOwners({ max: 3 });
    for (const t of ["1", "2", "3"]) o.set("C1", t, "UBOT");
    o.set("C1", "1", "UGOLF"); // answered again: now the newest
    o.set("C1", "4", "UBOT");
    expect(o.get("C1", "2")).toBeUndefined();
    expect(o.get("C1", "1")).toBe("UGOLF");
    expect(o.get("C1", "4")).toBe("UBOT");
  });

  it("CONVO-WHO-IS-ADDRESSED an unreadable record starts empty rather than stopping the worker", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "owners-")), "thread-owners.json");
    fs.writeFileSync(file, "{not json");
    expect(threadOwners({ file }).get("C1", "1.0")).toBeUndefined();
  });
});
