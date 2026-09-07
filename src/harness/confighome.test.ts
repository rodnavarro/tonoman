// Whose Claude subscription an agent runs on.
//
// One worker pod runs every agent a deployment has, and until now they shared a single
// CLAUDE_CONFIG_DIR — so the second person to sign in replaced the first, and every agent then
// answered, and billed, on whoever had authenticated most recently. Celine's assistant has to run
// on Celine's subscription and Rod's on Rod's; this function is where that becomes true.

import { describe, expect, it } from "vitest";
import { CONFIG_HOME, configHomeFor, localEnv } from "./claudecode";

describe("configHomeFor", () => {
  it("gives each agent its own directory", () => {
    expect(configHomeFor("nelly")).toBe(`${CONFIG_HOME}/agents/nelly`);
    expect(configHomeFor("sapien")).toBe(`${CONFIG_HOME}/agents/sapien`);
    expect(configHomeFor("nelly")).not.toBe(configHomeFor("sapien"));
  });

  it("falls back to the shared home when there is no agent", () => {
    // A self-hosted roster runs one agent with one login, and should not grow a directory level
    // for a distinction it does not have.
    expect(configHomeFor(undefined)).toBe(CONFIG_HOME);
    expect(configHomeFor("")).toBe(CONFIG_HOME);
  });

  it("REFUSES to let a name choose a path", () => {
    // The agent name arrives over the wire on /auth/login, and it decides where credentials are
    // read and written. Anything that could climb out of the directory would be a way to point a
    // login at somebody else's file — or at somewhere it should never write at all.
    expect(configHomeFor("../../etc")).toBe(`${CONFIG_HOME}/agents/etc`);
    expect(configHomeFor("a/b")).toBe(`${CONFIG_HOME}/agents/ab`);
    expect(configHomeFor("nelly; rm -rf /")).toBe(`${CONFIG_HOME}/agents/nellyrm-rf`);
    // A name that sanitises away is not the same as no name at all: falling back to the shared
    // home would hand the pool's credential to whatever nonsense was supplied.
    expect(configHomeFor("....//")).toBe(`${CONFIG_HOME}/agents/_invalid`);
    expect(configHomeFor("....//")).not.toBe(CONFIG_HOME);
  });

  it("keeps the characters a real agent name uses", () => {
    expect(configHomeFor("murphy-nelly_2")).toBe(`${CONFIG_HOME}/agents/murphy-nelly_2`);
  });
});

describe("localEnv", () => {
  it("points the turn at the agent's own credential", () => {
    const env = localEnv({}, "subscription", configHomeFor("nelly"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${CONFIG_HOME}/agents/nelly`);
  });

  it("still defaults to the shared home, so a single-agent deployment is unchanged", () => {
    expect(localEnv({}, "subscription").CLAUDE_CONFIG_DIR).toBe(CONFIG_HOME);
  });

  it("never lets an API key outrank the subscription", () => {
    // Unrelated to the split and worth keeping honest: an ANTHROPIC_API_KEY in the pod env would
    // silently bill somebody's card instead of using the OAuth login we just went to the trouble
    // of separating.
    expect(localEnv({ ANTHROPIC_API_KEY: "sk-should-not-survive" }, "subscription").ANTHROPIC_API_KEY).toBeUndefined();
  });
});
