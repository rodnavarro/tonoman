// Harness for the live GitAdapter. Git + the GitHub API are BOTH faked (injected), so this runs with
// no network, no token, no real repo — it asserts the command sequence and the API call shape.

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRepo, liveGitAdapter } from "./learn-git";

describe("parseRepo", () => {
  it("parses bare, https, and .git forms", () => {
    expect(parseRepo("github.com/example-org/tonoman-config")).toEqual({ owner: "example-org", name: "tonoman-config" });
    expect(parseRepo("https://github.com/example-org/tonoman-config.git")).toEqual({ owner: "example-org", name: "tonoman-config" });
  });
  it("throws on a non-GitHub url", () => {
    expect(() => parseRepo("gitlab.com/x/y")).toThrow(/cannot parse/);
  });
});

/** A git spy that records argv and returns canned output (sha for rev-parse, else ""). */
function gitSpy() {
  const calls: string[][] = [];
  const git = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("rev-parse")) return "deadbeef1234\n";
    return "";
  };
  return { git, calls };
}

describe("liveGitAdapter.openPr (shared → PR)", () => {
  it("clones, branches, writes the skill, pushes, and POSTs a PR — returns html_url; token in the auth header", async () => {
    const { git, calls } = gitSpy();
    let fetchUrl = "";
    let fetchInit: RequestInit | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      fetchUrl = url;
      fetchInit = init;
      return { status: 201, ok: true, json: async () => ({ html_url: "https://github.com/example-org/tonoman-config/pull/9" }) } as Response;
    }) as unknown as typeof fetch;

    const a = liveGitAdapter({
      token: "ghp_secret",
      author: { name: "sapien-agent", email: "sapien-agent@example.com" },
      configRepo: { owner: "example-org", name: "tonoman-config" },
      git,
      fetch: fakeFetch,
    });
    const url = await a.openPr({ branch: "learn/finance-intake-tag", path: "skills/finance-intake/SKILL.md", content: "# body", title: "skill(finance-intake): tag entity", body: "why" });

    expect(url).toBe("https://github.com/example-org/tonoman-config/pull/9");
    const flat = calls.flat();
    expect(flat).toEqual(expect.arrayContaining(["clone", "checkout", "add", "commit", "push"]));
    // API call: right endpoint, token auth, head/base in the body.
    expect(fetchUrl).toBe("https://api.github.com/repos/example-org/tonoman-config/pulls");
    expect((fetchInit!.headers as Record<string, string>).Authorization).toBe("token ghp_secret");
    expect(JSON.parse(fetchInit!.body as string)).toMatchObject({ head: "learn/finance-intake-tag", base: "main" });
  });

  it("on a 422 (PR already exists) returns the existing open PR url instead of throwing", async () => {
    const { git } = gitSpy();
    let call = 0;
    const fakeFetch = (async () => {
      call++;
      if (call === 1) return { status: 422, ok: false, json: async () => ({}) } as Response;
      return { status: 200, ok: true, json: async () => [{ html_url: "https://github.com/example-org/tonoman-config/pull/3" }] } as Response;
    }) as unknown as typeof fetch;
    const a = liveGitAdapter({ token: "t", author: { name: "n", email: "e" }, configRepo: { owner: "example-org", name: "tonoman-config" }, git, fetch: fakeFetch });
    const url = await a.openPr({ branch: "b", path: "skills/x/SKILL.md", content: "c", title: "t", body: "b" });
    expect(url).toBe("https://github.com/example-org/tonoman-config/pull/3");
  });

  it("refuses a shared write when no configRepo is set", async () => {
    const { git } = gitSpy();
    const a = liveGitAdapter({ token: "t", author: { name: "n", email: "e" }, git });
    await expect(a.openPr({ branch: "b", path: "p", content: "c", title: "t", body: "b" })).rejects.toThrow(/no config_repo/);
  });
});

describe("liveGitAdapter.commitToMain (personal → commit)", () => {
  it("clones the brain, writes the file, commits, pushes HEAD:main, returns the SHA", async () => {
    const { git, calls } = gitSpy();
    const a = liveGitAdapter({ token: "t", author: { name: "sapien-agent", email: "e" }, brainRepo: { owner: "example-org", name: "sapien-agent" }, git });
    const sha = await a.commitToMain({ file: "LEARNED.md", content: "- rule: always tag the entity", message: "learn: entity rule" });
    expect(sha).toBe("deadbeef1234");
    const pushed = calls.find((c) => c.includes("push"));
    expect(pushed).toContain("HEAD:main");
  });

  it("refuses a personal write when neither brainRepo nor brainDir is set", async () => {
    const { git } = gitSpy();
    const a = liveGitAdapter({ token: "t", author: { name: "n", email: "e" }, git });
    await expect(a.commitToMain({ file: "LEARNED.md", content: "x", message: "m" })).rejects.toThrow(/no brain repo/);
  });

  it("in-place (brainDir) PULLS the live checkout, appends the rule, pushes — no clone", async () => {
    const { git, calls } = gitSpy();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnbrain-"));
    await fs.writeFile(path.join(dir, "LEARNED.md"), "- prior rule\n"); // an existing log
    const a = liveGitAdapter({ token: "t", author: { name: "sapien-agent", email: "e" }, brainRepo: { owner: "example-org", name: "sapien-agent" }, brainDir: dir, git });
    const sha = await a.commitToMain({ file: "LEARNED.md", content: "- always tag the entity", message: "learn: entity rule" });
    expect(sha).toBe("deadbeef1234");
    const flat = calls.flat();
    expect(flat).toContain("pull"); // freshened in place
    expect(flat).not.toContain("clone"); // did NOT clone a temp copy
    const written = await fs.readFile(path.join(dir, "LEARNED.md"), "utf8");
    expect(written).toContain("- prior rule"); // appended, not clobbered
    expect(written).toContain("- always tag the entity");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
