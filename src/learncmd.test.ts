import { describe, it, expect } from "vitest";
import { parseLearnArgs, runLearn } from "./learncmd";
import type { GitAdapter } from "./learn";

describe("parseLearnArgs", () => {
  it("parses a shared skill write", () => {
    expect(parseLearnArgs(["--scope", "shared", "--skill", "finance-intake", "--content", "body", "--reason", "tag entity"])).toEqual({
      scope: "shared",
      skill: "finance-intake",
      content: "body",
      reason: "tag entity",
    });
  });

  it("parses a personal write with a content file", () => {
    expect(parseLearnArgs(["--scope", "personal", "--content-file", "/tmp/x", "--reason", "why"])).toMatchObject({ scope: "personal", contentFile: "/tmp/x", reason: "why" });
  });

  it("rejects a bad scope, a missing reason, shared-without-skill, and no content", () => {
    expect(() => parseLearnArgs(["--scope", "nope", "--reason", "r", "--content", "c"])).toThrow(/--scope must be/);
    expect(() => parseLearnArgs(["--scope", "personal", "--content", "c"])).toThrow(/--reason is required/);
    expect(() => parseLearnArgs(["--scope", "shared", "--reason", "r", "--content", "c"])).toThrow(/needs --skill/);
    expect(() => parseLearnArgs(["--scope", "personal", "--reason", "r"])).toThrow(/--content or --content-file/);
    expect(() => parseLearnArgs(["--bogus"])).toThrow(/unknown flag/);
  });
});

describe("runLearn — routes through persist and prints a JSON receipt", () => {
  function fakeGit(pr: string) {
    const calls: { openPr: unknown[]; commitToMain: unknown[] } = { openPr: [], commitToMain: [] };
    const git: GitAdapter = {
      async commitToMain(i) { calls.commitToMain.push(i); return "sha123456"; },
      async openPr(i) { calls.openPr.push(i); return pr; },
    };
    return { git, calls };
  }

  it("shared → opens a PR and prints ok:true with the PR url", async () => {
    const { git, calls } = fakeGit("https://github.com/example-org/tonoman-config/pull/9");
    let printed = "";
    await runLearn(
      ["--scope", "shared", "--skill", "finance-intake", "--content", "# new body", "--reason", "tag entity"],
      { persistDeps: { git, configRepo: "github.com/example-org/tonoman-config" }, out: (s) => (printed += s) },
    );
    expect(calls.openPr).toHaveLength(1);
    const j = JSON.parse(printed);
    expect(j).toMatchObject({ ok: true, scope: "shared", mode: "pr", ref: "https://github.com/example-org/tonoman-config/pull/9" });
  });
});
