// Contract tests for the learn-durable memory substrate. FREE: git is faked, no network, no tokens.
// Covers learn-route-by-scope, learn-personal-commit, learn-shared-skill-pr, learn-registry-from-config.

import { describe, it, expect } from "vitest";
import { persist, type GitAdapter, type PersistDeps } from "./learn";

/** A recording fake GitAdapter — captures the calls, returns canned refs, spies which path ran. */
function fakeGit() {
  const calls: { commitToMain: unknown[]; openPr: unknown[] } = { commitToMain: [], openPr: [] };
  const git: GitAdapter = {
    async commitToMain(input) {
      calls.commitToMain.push(input);
      return "abc1234def5678";
    },
    async openPr(input) {
      calls.openPr.push(input);
      return "https://github.com/example-org/tonoman-config/pull/7";
    },
  };
  return { git, calls };
}

const deps = (over: Partial<PersistDeps> = {}): PersistDeps => ({ git: fakeGit().git, ...over });

describe("persist — route by scope (learn-route-by-scope)", () => {
  it("personal → commits to the agent's own brain on main, never opens a PR", async () => {
    const { git, calls } = fakeGit();
    const r = await persist({ scope: "personal", content: "Call the Gainesville landlord 'Gainesville'.", reason: "landlord label" }, { git });
    expect(calls.commitToMain).toHaveLength(1);
    expect(calls.openPr).toHaveLength(0); // NEVER a PR for a personal note
    expect(calls.commitToMain[0]).toMatchObject({ file: "LEARNED.md", message: "learn: landlord label" });
    expect(r).toMatchObject({ scope: "personal", mode: "commit", ref: "abc1234def5678" });
    expect(r.summary).toContain("abc1234"); // receipt carries the short SHA
  });

  it("shared → opens a PR against config_repo, never self-commits", async () => {
    const { git, calls } = fakeGit();
    const r = await persist(
      { scope: "shared", target: "finance-intake", content: "# updated skill body", reason: "always tag the entity" },
      { git, configRepo: "github.com/example-org/tonoman-config" },
    );
    expect(calls.openPr).toHaveLength(1);
    expect(calls.commitToMain).toHaveLength(0); // NEVER a direct commit for a shared skill
    expect(calls.openPr[0]).toMatchObject({ path: "skills/finance-intake/SKILL.md", branch: "learn/finance-intake-always-tag-the-entity" });
    expect(r).toMatchObject({ scope: "shared", mode: "pr", ref: "https://github.com/example-org/tonoman-config/pull/7" });
    expect(r.summary).toContain("pending review");
  });
});

describe("persist — registry from config (learn-registry-from-config)", () => {
  it("refuses a shared write when no config_repo is set (personal-only org), never mis-routes to own repo", async () => {
    const { git, calls } = fakeGit();
    await expect(persist({ scope: "shared", target: "finance-intake", content: "x", reason: "y" }, { git })).rejects.toThrow(/no shared skill registry/);
    expect(calls.commitToMain).toHaveLength(0); // did NOT fall back to a personal commit
    expect(calls.openPr).toHaveLength(0);
  });

  it("refuses a shared write with no target skill", async () => {
    await expect(persist({ scope: "shared", content: "x", reason: "y" }, deps({ configRepo: "r" }))).rejects.toThrow(/needs a target skill/);
  });
});

describe("persist — deterministic branch (retry-safe)", () => {
  it("derives the branch from the reason slug (no clock/random), so a retry targets the same branch", async () => {
    const { git, calls } = fakeGit();
    const req = { scope: "shared" as const, target: "finance-intake", content: "x", reason: "Always tag the Entity!" };
    await persist(req, { git, configRepo: "r" });
    await persist(req, { git, configRepo: "r" });
    expect((calls.openPr[0] as { branch: string }).branch).toBe((calls.openPr[1] as { branch: string }).branch);
    expect((calls.openPr[0] as { branch: string }).branch).toBe("learn/finance-intake-always-tag-the-entity");
  });
});
