import { describe, expect, it } from "vitest";
import { __testing, agentsAllowed } from "./worker";

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

describe("agentsAllowed — which agents this process takes", () => {
  it("empty means all of them, which is every deployment today", () => {
    expect(agentsAllowed(undefined).size).toBe(0);
    expect(agentsAllowed("").size).toBe(0);
    expect(agentsAllowed(" , ,  ").size).toBe(0);
  });

  it("splits, trims and lower-cases, because somebody will copy this out of a log", () => {
    expect([...agentsAllowed("acme-sapien, Initech-Nelly ")]).toEqual(["acme-sapien", "initech-nelly"]);
  });

  it("exists so two workers never share an agent", () => {
    // Slack delivers a Socket Mode event to exactly ONE connection holding that app token, so two
    // processes serving the same agent answer alternately and unpredictably — which reads as a
    // flaky bug rather than as two workers.
    const a = agentsAllowed("acme-sapien");
    const b = agentsAllowed("initech-nelly");
    expect([...a].some((x) => b.has(x))).toBe(false);
  });
});

describe("the path every real turn takes (Tonoman Cloud docs/definition/objects/cli.md)", () => {
  const cli = { binDir: "/opt/tonoman/bin", env: { TONOMAN_BRAIN_URL: "http://127.0.0.1:9", TONOMAN_BRAIN_TOKEN: "t" } };
  const tool = { name: "tonoman", command: "/usr/bin/node", args: ["/opt/tonoman/tonoman-mcp.cjs"], env: cli.env };
  const ran = async (cfg: object, r: object): Promise<Record<string, unknown>> => {
    const seen: Record<string, unknown>[] = [];
    const runner = {
      run: async function* (req: Record<string, unknown>) {
        seen.push(req);
        yield { kind: "done", final: "ok" };
      },
    };
    const run = __testing.runClosure(runner as never, { name: "sapien", inference_mode: "shared", ...cfg } as never);
    for await (const _ of run({ prompt: "hi", ...r } as never)) void _;
    return seen[0];
  };

  it("CLI-ONE-COMMAND what the turn was given reaches the harness: tonoman, its one tool, its folder", async () => {
    const got = await ran({}, { cli, mcpServers: [tool], cwd: "/tmp/t" });
    expect(got.cli).toEqual(cli);
    expect(got.mcpServers).toEqual([tool]);
    expect(got.cwd).toBe("/tmp/t");
  });

  it("CLI-SHELL-SETTING the harness is told the agent's shell setting, and an agent with none set has tonoman only", async () => {
    expect((await ran({}, { cli })).shell).toBe("tonoman");
    expect((await ran({ shell: "full" }, { cli })).shell).toBe("full");
    expect((await ran({ shell: "anything-else" }, { cli })).shell).toBe("tonoman");
  });

  it("CLI-CLOSED-WHATEVER-FAILS a turn that was given no tonoman still reaches the harness with the shell closed", async () => {
    expect((await ran({}, {})).shell).toBe("tonoman");
  });
});

describe("every run of an agent goes out as its turn's user (Tonoman Cloud docs/definition/objects/turn-user.md)", () => {
  const events: string[] = [];
  const users = (fails = false, left = false) => ({
    for: async (agentGuid: string, speaker: string | undefined) => {
      events.push(`for:${agentGuid}:${speaker ?? "-"}`);
      if (fails) throw new Error("the Cloud did not answer");
      return speaker && !left ? { uid: 20002, home: "/srv/tonoman/homes/20002", of: "person" as const } : { uid: 20001, home: "/srv/tonoman/homes/20001", of: "agent" as const };
    },
    handOver: async (user: { uid: number }, what: { cwd?: string; configHome: string; oldConfigHome?: string }) => {
      events.push(`handOver:${user.uid}:${what.cwd ?? "-"}:${what.configHome}`);
      broughtFrom.push(what.oldConfigHome);
    },
  });
  const broughtFrom: (string | undefined)[] = [];
  const ranWith = async (cfg: object, r: object, u: ReturnType<typeof users> | undefined) => {
    const seen: Record<string, unknown>[] = [];
    const runner = {
      run: async function* (req: Record<string, unknown>) {
        events.push("run");
        seen.push(req);
        yield { kind: "done", final: "ok" };
      },
    };
    const run = __testing.runClosure(runner as never, { name: "acme-Sapien", guid: "g-sapien", inference_mode: "per_user", inference_provider: "codex", ...cfg } as never, u as never);
    for await (const _ of run({ prompt: "hi", ...r } as never)) void _;
    return seen[0];
  };

  it("TURNUSER-WHOSE the run is handed the user the Cloud says it is — asked by the agent and who is speaking — with its login inside that user's home", async () => {
    events.length = 0;
    const got = await ranWith({}, { user: "UANA", cwd: "/tmp/tonoman-turn-x" }, users());
    expect(got!.runAs).toEqual({ uid: 20002, home: "/srv/tonoman/homes/20002" });
    expect(got!.configHome).toBe("/srv/tonoman/homes/20002/agents/acme-Sapien/codex");
    // Asked, then the turn's folder and login handed over, and only then run.
    expect(events).toEqual(["for:g-sapien:UANA", "handOver:20002:/tmp/tonoman-turn-x:/srv/tonoman/homes/20002/agents/acme-Sapien/codex", "run"]);
  });

  it("TURNUSER-WHOSE whose old login may come home follows whose user the Cloud says it is: someone who has left the tenant runs as the agent's user, and THEIR login is never brought into it", async () => {
    broughtFrom.length = 0;
    await ranWith({}, { user: "UANA" }, users());
    expect(broughtFrom.at(-1)).toMatch(/users[\/]UANA$/);
    await ranWith({}, { user: "UANA" }, users(false, true)); // per-person agent, but Ana has left
    expect(broughtFrom.at(-1)).not.toMatch(/UANA/);
  });

  it("TURNUSER-NOTHING-AS-ROOT an agent that runs in a container of its own cannot be started as a user from here, so it is not started", async () => {
    events.length = 0;
    await expect(ranWith({ container: "tonoman-alpha" }, { user: "UANA" }, users())).rejects.toThrow(/container of its own/);
    expect(events).not.toContain("run");
  });

  it("TURNUSER-NOTHING-AS-ROOT a Talent's inference, which nobody is speaking in, goes out as a user too", async () => {
    events.length = 0;
    const got = await ranWith({ inference_provider: "claude" }, { lean: true }, users());
    expect(got!.runAs).toEqual({ uid: 20001, home: "/srv/tonoman/homes/20001" });
    expect(got!.configHome).toBe("/srv/tonoman/homes/20001/agents/acme-Sapien/claude");
  });

  it("TURNUSER-NOTHING-AS-ROOT when the user cannot be had, nothing runs: never as root instead", async () => {
    events.length = 0;
    await expect(ranWith({}, { user: "UANA" }, users(true))).rejects.toThrow(/did not answer/);
    expect(events).not.toContain("run");
  });

  it("TURNUSER-NOTHING-AS-ROOT a self-hosted worker, with no users, runs exactly as before", async () => {
    const got = await ranWith({}, { user: "UANA" }, undefined);
    expect(got!.runAs).toBeUndefined();
  });
});
