import { describe, expect, it } from "vitest";
import { __testing } from "./worker";

const { disallowedTools, DEFAULT_DISALLOWED } = __testing;

describe("disallowedTools — the pod is the sandbox, so the tool list is the boundary", () => {
  const withEnv = (v: string | undefined, fn: () => void): void => {
    const had = process.env.CLAUDE_CODE_DISALLOWED_TOOLS;
    if (v === undefined) delete process.env.CLAUDE_CODE_DISALLOWED_TOOLS;
    else process.env.CLAUDE_CODE_DISALLOWED_TOOLS = v;
    try {
      fn();
    } finally {
      if (had === undefined) delete process.env.CLAUDE_CODE_DISALLOWED_TOOLS;
      else process.env.CLAUDE_CODE_DISALLOWED_TOOLS = had;
    }
  };

  it("withholds the shell by DEFAULT — this pod holds the credential that buys the inference", () => {
    withEnv(undefined, () => {
      expect(disallowedTools()).toContain("Bash");
      expect(disallowedTools()).toEqual(DEFAULT_DISALLOWED);
    });
  });

  it("withholds everything that writes or fetches, not only the shell", () => {
    withEnv(undefined, () => {
      for (const t of ["Write", "Edit", "WebFetch"]) expect(disallowedTools()).toContain(t);
    });
  });

  it("leaves reading and searching alone — that is what a second brain is for", () => {
    withEnv(undefined, () => {
      for (const t of ["Read", "Grep", "Glob"]) expect(disallowedTools()).not.toContain(t);
    });
  });

  it("an EMPTY variable is an unset one, not a request to allow everything", () => {
    withEnv("", () => expect(disallowedTools()).toEqual(DEFAULT_DISALLOWED));
    withEnv("   ", () => expect(disallowedTools()).toEqual(DEFAULT_DISALLOWED));
  });

  it("takes an explicit list when the operator sets one", () => {
    withEnv("Bash, Task", () => expect(disallowedTools()).toEqual(["Bash", "Task"]));
  });

  it("only the word 'none' hands everything over, so it has to be meant", () => {
    withEnv("none", () => expect(disallowedTools()).toEqual([]));
    withEnv("NONE", () => expect(disallowedTools()).toEqual([]));
  });
});
