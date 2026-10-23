// SKILL-FROM-YOUR-REPO, SKILL-REPO-TOOLS-IN-TURN (skill.md in Tonoman Cloud): a tenant's skills repo at
// a commit, checked out once, its tools found from its package and its install scripts never run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { repoSkills, skillBody, toolsOf } from "./reposkills";

let tmp: string;
let repo: string;
let commit: string;
const npmCalls: string[][] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "reposkills-"));
  repo = path.join(tmp, "skills-repo");
  mkdirSync(path.join(repo, "skills", "tax-return-summary"), { recursive: true });
  mkdirSync(path.join(repo, "tools", "reader"), { recursive: true });
  writeFileSync(path.join(repo, "skills", "tax-return-summary", "SKILL.md"), "---\nname: tax-return-summary\ndescription: Summarize a return.\n---\n\n# Summarizing\n\nRun `reader tax read`.\n");
  writeFileSync(path.join(repo, "tools", "reader", "cli.js"), "console.log('read');\n");
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "firm-tools", description: "The firm's tools", bin: { reader: "tools/reader/cli.js", "../escape": "x.js" }, scripts: { postinstall: "touch pwned" } }));
  writeFileSync(path.join(repo, "package-lock.json"), "{}");
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo });
  g("init", "-q", "-b", "main");
  g("add", ".");
  g("commit", "-q", "-m", "skills");
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  npmCalls.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const fakeNpm = async (cmd: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv }) => {
  if (cmd === "npm") {
    npmCalls.push(args);
    return "";
  }
  return execFileSync(cmd, args, { cwd: o.cwd, env: o.env }).toString();
};

describe("a tenant's own skills", () => {
  it("SKILL-REPO-TOOLS-IN-TURN a skill's instructions come without their frontmatter", () => {
    expect(skillBody("---\nname: x\ndescription: y\n---\n# Hi\n\nThere.\n")).toBe("# Hi\n\nThere.");
  });

  it("SKILL-REPO-TOOLS-IN-TURN a repository's tools are its package's bin, inside it; a path out of it is refused", () => {
    const tools = toolsOf({ name: "p", description: "d", bin: { reader: "tools/reader/cli.js", evil: "../x.js", abs: "/bin/sh" } }, "/srv/repo");
    expect(tools).toEqual([{ name: "reader", script: path.join("/srv/repo", "tools/reader/cli.js"), about: "d" }]);
  });

  it("SKILL-FROM-YOUR-REPO the commit is checked out once, its packages installed with their scripts off, and the skill's instructions and tools handed over", async () => {
    const r = repoSkills({ root: path.join(tmp, "out"), token: async () => "", exec: fakeNpm, log: () => {} });
    const spec = [{ name: "tax-return-summary", repoUrl: repo, commit, path: "skills/tax-return-summary" }];
    const a = await r.prepare("agent-1", spec);
    expect(a.notes).toEqual([{ name: "tax-return-summary", body: "# Summarizing\n\nRun `reader tax read`." }]);
    expect(a.tools.map((t) => t.name)).toEqual(["reader"]);
    expect(existsSync(a.tools[0]!.script)).toBe(true);
    expect(npmCalls).toEqual([["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    // Asked again, by another agent of the tenant: the same checkout, nothing installed twice.
    await r.prepare("agent-2", spec);
    expect(npmCalls).toHaveLength(1);
  });

  it("SKILL-FROM-YOUR-REPO a skill that cannot be prepared is left out; the turn goes on without it", async () => {
    const r = repoSkills({ root: path.join(tmp, "out"), token: async () => "", exec: fakeNpm, log: () => {} });
    const a = await r.prepare("agent-1", [{ name: "gone", repoUrl: repo, commit: "0".repeat(40), path: "skills/gone" }]);
    expect(a).toEqual({ tools: [], notes: [] });
  });
});
