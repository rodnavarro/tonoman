import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { sync } from "./secondbrain";

// Tonoman Cloud docs/definition/objects/brain.md. A REAL remote that really moves, because the thing
// under test is what git leaves on disk — on Sep 20 one checkout of a 1.9 GB tree held 57 GB in 33
// packs and took production's node out of disk. `sync` had no test of any kind before this.
const BLOB = 256 * 1024; // incompressible, so every new tip really is BLOB bytes that cannot be shared

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@tonoman.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();

const packs = (checkout: string) => fs.readdirSync(path.join(checkout, ".git", "objects", "pack")).filter((n) => n.endsWith(".pack"));
const objectsBytes = (checkout: string): number => {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(path.join(checkout, ".git", "objects"));
  return total;
};

/** Make everything git holds look two hours old, as it is when the tip next moves in production:
 *  the object files by their mtime, and the reflog by the time written INSIDE each entry, which is
 *  what `reflog expire` reads. */
const age = (checkout: string) => {
  const then = new Date(Date.now() - 2 * 3600 * 1000);
  const walk = (d: string, each: (p: string) => void) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, each);
      else each(p);
    }
  };
  walk(path.join(checkout, ".git", "objects"), (p) => fs.utimesSync(p, then, then));
  walk(path.join(checkout, ".git", "logs"), (p) =>
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/> (\d+) ([+-]\d{4})\t/g, (_m, t, tz) => `> ${Number(t) - 7200} ${tz}\t`)),
  );
};

describe("the second brain's checkout, as the remote moves", () => {
  let tmp: string, remote: string, author: string, root: string;
  const move = (n: number) => {
    fs.writeFileSync(path.join(author, "big.bin"), randomBytes(BLOB));
    fs.writeFileSync(path.join(author, "page.md"), `# page, as of move ${n}\n`);
    git(author, "add", "-A");
    git(author, "commit", "-q", "-m", `move ${n}`);
    git(author, "push", "-q", "origin", "main");
  };
  const source = () => [{ id: "wiki", label: "wiki", repoUrl: pathToFileURL(remote).toString(), branch: "main", secretRef: null }];
  const opts = () => ({ root, resolveRef: async () => "", log: () => {} });

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tonoman-sb-"));
    remote = path.join(tmp, "remote.git");
    author = path.join(tmp, "author");
    root = path.join(tmp, "checkouts");
    git(tmp, "init", "-q", "--bare", "-b", "main", remote);
    git(tmp, "clone", "-q", remote, author);
    git(author, "checkout", "-q", "-B", "main");
    move(0);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("BRAIN-TODAY-CHECKOUT-STAYS-SMALL however many times the remote moves, the checkout holds its tip and the one before, never a copy per move", async () => {
    const [first] = await sync(source(), opts());
    expect(first).toBeDefined();
    const checkout = path.join(root, "wiki");
    const afterClone = objectsBytes(checkout);

    for (let n = 1; n <= 6; n++) {
      move(n);
      age(checkout); // in production hours pass between moves; only what has aged may be pruned
      await sync(source(), opts());
    }

    // It follows the remote...
    expect(fs.readFileSync(path.join(checkout, "page.md"), "utf8")).toContain("move 6");
    // ...and what each refresh brought down took the place of what was there. Six moves of an
    // incompressible blob would be ~7x the clone if every pack were kept, which is what happened.
    expect(packs(checkout).length).toBeLessThanOrEqual(2);
    // Two copies at most: the tip it has and the one before, which the reflog keeps for an hour so
    // that the checkout's other writer is never pruned from under. Kept packs would be ~7x.
    expect(objectsBytes(checkout)).toBeLessThan(afterClone * 3.5);
  }, 120_000);

  it("BRAIN-TODAY-CHECKOUT-STAYS-SMALL what another writer has just written and not yet committed survives the tidying", async () => {
    const checkout = path.join(root, "wiki");
    // The recap publisher works in this same checkout. Between its `git add` and its `git commit`
    // its objects are referenced by nothing - exactly what an immediate prune would take.
    fs.writeFileSync(path.join(tmp, "recap.md"), "# a recap, written a moment ago");
    const oid = git(checkout, "hash-object", "-w", path.join(tmp, "recap.md")).trim();
    move(7);
    await sync(source(), opts());
    expect(() => git(checkout, "cat-file", "-e", oid)).not.toThrow();
  }, 60_000);

  it("BRAIN-TODAY-CHECKOUT-STAYS-SMALL a refresh that finds the remote unchanged leaves the checkout as it was", async () => {
    const checkout = path.join(root, "wiki");
    const before = { packs: packs(checkout).sort(), bytes: objectsBytes(checkout) };
    await sync(source(), opts());
    await sync(source(), opts());
    expect(packs(checkout).sort()).toEqual(before.packs);
    expect(objectsBytes(checkout)).toBe(before.bytes);
  }, 60_000);
});
