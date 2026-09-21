// Whose Claude subscription an agent runs on.
//
// One worker pod runs every agent a deployment has, and until now they shared a single
// CLAUDE_CONFIG_DIR — so the second person to sign in replaced the first, and every agent then
// answered, and billed, on whoever had authenticated most recently. Priya's assistant has to run
// on Priya's subscription and Rod's on Rod's; this function is where that becomes true.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_HOME, configHomeFor, localEnv, shareConversationHistory } from "./claudecode";

describe("shareConversationHistory — the conversation is the agent's, the subscription the person's", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true });
  });
  const tree = async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "share-history-"));
    roots.push(root);
    const agent = path.join(root, "agents", "sapien");
    return { agent, userA: path.join(agent, "users", "UA"), userB: path.join(agent, "users", "UB") };
  };
  const write = async (file: string, text: string) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text);
  };

  it("a session one person started is readable through the other person's login", async () => {
    const { agent, userA, userB } = await tree();
    await shareConversationHistory(userA);
    await shareConversationHistory(userB);
    await write(path.join(userA, "projects", "-opt-tonoman", "s1.jsonl"), "from A");
    expect(await fsp.readFile(path.join(userB, "projects", "-opt-tonoman", "s1.jsonl"), "utf8")).toBe("from A");
    expect(await fsp.readFile(path.join(agent, "projects", "-opt-tonoman", "s1.jsonl"), "utf8")).toBe("from A");
  });

  it("moves a person's existing transcripts into the agent's history instead of losing them", async () => {
    const { agent, userA } = await tree();
    await write(path.join(userA, "projects", "-opt-tonoman", "old.jsonl"), "earlier");
    await shareConversationHistory(userA);
    expect(await fsp.readFile(path.join(agent, "projects", "-opt-tonoman", "old.jsonl"), "utf8")).toBe("earlier");
    expect((await fsp.lstat(path.join(userA, "projects"))).isSymbolicLink()).toBe(true);
  });

  it("never overwrites the agent's copy: a clash is kept aside, not deleted", async () => {
    const { agent, userA } = await tree();
    await write(path.join(agent, "projects", "-opt-tonoman", "same.jsonl"), "agent's");
    await write(path.join(userA, "projects", "-opt-tonoman", "same.jsonl"), "person's");
    await shareConversationHistory(userA);
    expect(await fsp.readFile(path.join(agent, "projects", "-opt-tonoman", "same.jsonl"), "utf8")).toBe("agent's");
    const kept = (await fsp.readdir(userA)).find((n) => n.startsWith("projects.unshared-"));
    expect(kept).toBeDefined();
    expect(await fsp.readFile(path.join(userA, kept!, "-opt-tonoman", "same.jsonl"), "utf8")).toBe("person's");
  });

  it("is idempotent, and leaves a home that is not a per-person login alone", async () => {
    const { agent, userA } = await tree();
    await shareConversationHistory(userA);
    await shareConversationHistory(userA);
    expect((await fsp.lstat(path.join(userA, "projects"))).isSymbolicLink()).toBe(true);
    await shareConversationHistory(agent);
    expect(await fsp.lstat(path.join(agent, "projects")).then((s) => s.isSymbolicLink())).toBe(false);
  });
});

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
    expect(configHomeFor("initech-nelly_2")).toBe(`${CONFIG_HOME}/agents/initech-nelly_2`);
  });

  it("gives each PERSON their own directory under a per-user agent", () => {
    // When an agent runs inference per person, the speaker's Slack user id names a login UNDER the
    // agent, so two teammates on one agent answer on their own subscriptions.
    expect(configHomeFor("sapien", "U123")).toBe(`${CONFIG_HOME}/agents/sapien/users/U123`);
    expect(configHomeFor("sapien", "U123")).not.toBe(configHomeFor("sapien", "U999"));
    // The per-user dir is never the agent's shared dir — that separation is the whole point.
    expect(configHomeFor("sapien", "U123")).not.toBe(configHomeFor("sapien"));
  });

  it("no user means the agent's ONE shared login — every agent today", () => {
    expect(configHomeFor("sapien", undefined)).toBe(`${CONFIG_HOME}/agents/sapien`);
    expect(configHomeFor("sapien", "")).toBe(`${CONFIG_HOME}/agents/sapien`);
  });

  it("REFUSES to let a user id choose a path either", () => {
    // The user id arrives over the wire the same way the agent name does, and points at where a
    // person's credential is read and written.
    expect(configHomeFor("sapien", "../../etc")).toBe(`${CONFIG_HOME}/agents/sapien/users/etc`);
    expect(configHomeFor("sapien", "....//")).toBe(`${CONFIG_HOME}/agents/sapien/users/_invalid`);
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
    expect(localEnv({ ANTHROPIC_API_KEY: "placeholder-that-must-not-survive" }, "subscription").ANTHROPIC_API_KEY).toBeUndefined(); // scan:allow a placeholder, not a key: the test is that the variable is dropped
  });
});
