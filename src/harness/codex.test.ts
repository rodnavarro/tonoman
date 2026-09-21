import { describe, it, expect } from "vitest";
import { parseLine, mapUsage, normalizeModel, shortModel, localEnv, ensureCodexHome, identityPreamble, parseCodexRateLimits, CODEX_CONTEXT_WINDOW } from "./codex";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

describe("codex harness — model normalization (gw-command-model)", () => {
  it("maps the friendly tier aliases to gpt-5.6 slugs, passes slugs/unknowns through", () => {
    expect(normalizeModel("sol")).toBe("gpt-5.6-sol");
    expect(normalizeModel("terra")).toBe("gpt-5.6-terra");
    expect(normalizeModel("luna")).toBe("gpt-5.6-luna");
    expect(normalizeModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeModel(undefined)).toBeUndefined();
  });
  it("shortModel compacts a slug for the statusline", () => {
    expect(shortModel("gpt-5.6-sol")).toBe("sol");
    expect(shortModel("gpt-5.1-codex")).toBe("5.1-codex");
  });
});

describe("codex harness — event parsing (the --json stream → neutral TurnEvent)", () => {
  it("agent_message item → a text event", () => {
    const ev = parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
    expect(ev).toEqual({ kind: "text", text: "hello" });
  });
  it("a non-message item (file_change/command) → a tool event with a bounded label", () => {
    const ev = parseLine(JSON.stringify({ type: "item.completed", item: { type: "file_change", status: "completed" } }));
    expect(ev?.kind).toBe("tool");
    expect(ev?.tool).toBe("file_change");
  });
  it("an MCP tool call is named by its server and tool, as Claude names it (mcp__brain__brain_pages)", () => {
    const ev = parseLine(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "brain", tool: "brain_pages", status: "completed" } }));
    expect(ev?.kind).toBe("tool");
    expect(ev?.tool).toBe("mcp__brain__brain_pages");
  });
  it("turn.completed → a done event carrying normalized usage", () => {
    const ev = parseLine(
      JSON.stringify({ type: "turn.completed", model: "gpt-5.6-sol", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5 } }),
    );
    expect(ev?.kind).toBe("done");
    expect(ev?.usage?.inputTokens).toBe(20); // fresh = total(100) − cached(80)
    expect(ev?.usage?.cacheReadTokens).toBe(80);
    expect(ev?.usage?.outputTokens).toBe(25); // output + reasoning
    expect(ev?.usage?.contextTokens).toBe(100);
    expect(ev?.usage?.model).toBe("sol");
    expect(ev?.usage?.contextWindow).toBe(CODEX_CONTEXT_WINDOW);
  });
  it("thread.started / turn.started / non-JSON banners → null (ignored)", () => {
    expect(parseLine(JSON.stringify({ type: "thread.started", thread_id: "x" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "turn.started" }))).toBeNull();
    expect(parseLine("Reading prompt from stdin...")).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("codex harness — account usage window (5h/7d, like claude's statusline)", () => {
  it("maps codex rate_limits (rollout format) to neutral UsageWindows, 5h before 7d", () => {
    const w = parseCodexRateLimits({
      primary: { used_percent: 3, window_minutes: 10080, resets_at: 1786507094 },
      secondary: { used_percent: 41, window_minutes: 300, resets_at: 1786500000 },
    });
    expect(w.map((x) => x.key)).toEqual(["5h", "7d"]); // shorter window first
    const five = w.find((x) => x.key === "5h")!;
    expect(five.usedPct).toBe(41);
    expect(five.resetAt).toBe(new Date(1786500000 * 1000).toISOString());
  });
  it("returns [] when there is no rate_limits (never throws)", () => {
    expect(parseCodexRateLimits(undefined)).toEqual([]);
    expect(parseCodexRateLimits({})).toEqual([]);
  });
});

describe("codex harness — env + identity (ToS-safe subscription, no API key)", () => {
  it("localEnv points CODEX_HOME at the config volume and drops OPENAI_API_KEY", () => {
    const env = localEnv({ OPENAI_API_KEY: "should-be-dropped", PATH: "/x" }); // scan:allow test fixture, not a real key — asserts the key is dropped
    expect(env.CODEX_HOME).toBe("/root/.codex");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/x");
  });
  it("identityPreamble is empty when no file is given (a missing persona never fails a turn)", () => {
    expect(identityPreamble(undefined)).toBe("");
    expect(identityPreamble("/no/such/file/xyz")).toBe("");
  });
});

describe("codex harness — CODEX_HOME must exist (codex refuses a missing one)", () => {
  it("localEnv creates the config home it points at", () => {
    const home = path.join(os.tmpdir(), `codexhome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect(fs.existsSync(home)).toBe(false);
    const env = localEnv(process.env, home);
    expect(env.CODEX_HOME).toBe(home);
    expect(fs.existsSync(home)).toBe(true);
    // and never carries an API key that would outrank the subscription
    expect(env.OPENAI_API_KEY).toBeUndefined();
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("ensureCodexHome is idempotent", () => {
    const home = path.join(os.tmpdir(), `codexhome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ensureCodexHome(home);
    ensureCodexHome(home);
    expect(fs.existsSync(home)).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("tonoman, the only command (Tonoman Cloud docs/definition/objects/cli.md)", () => {
  it("CLI-ONLY-THIS-COMMAND a Codex turn with tonoman has no shell at all, and one tool: tonoman", async () => {
    const { Runner } = await import("./codex");
    const tool = { name: "tonoman", command: "/usr/bin/node", args: ["/srv/tonoman/tonoman-mcp.cjs"], env: { TONOMAN_BRAIN_TOKEN: "t" } };
    const args = new Runner({ local: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t", cli: { binDir: "/srv/tonoman/bin", env: {} }, mcpServers: [tool] } as never);
    const cfg = args.filter((_, i) => args[i - 1] === "-c");
    expect(cfg).toContain("features.shell_tool=false");
    expect(cfg).toContain("features.unified_exec=false");
    expect(cfg.filter((c) => c.startsWith("mcp_servers.")).map((c) => c.split(".")[1])).toEqual(["tonoman", "tonoman", "tonoman"]);
  });

  it("CLI-CLOSED-WHATEVER-FAILS a Codex turn that was given no tonoman (the brain service is down) still has no shell", async () => {
    const { Runner } = await import("./codex");
    const args = new Runner({ local: true, closedShell: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t" } as never);
    const cfg = args.filter((_, i) => args[i - 1] === "-c");
    expect(cfg).toContain("features.shell_tool=false");
  });

  it("CLI-SHELL-SETTING a Codex agent set to a full shell keeps it; nobody else does", async () => {
    const { Runner } = await import("./codex");
    const full = new Runner({ local: true, closedShell: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t", shell: "full" } as never);
    expect(full.join(" ")).not.toContain("shell_tool=false");
    const unset = new Runner({ local: true, closedShell: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t", shell: undefined } as never);
    expect(unset.join(" ")).toContain("features.shell_tool=false");
  });

  it("CLI-CODEX-ONLY-ITS-TOOL a Codex turn has no child agents, no plugins and no hooks", async () => {
    const { Runner } = await import("./codex");
    const args = new Runner({ local: true, closedShell: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t" } as never);
    const cfg = args.filter((_, i) => args[i - 1] === "-c");
    for (const off of ["features.multi_agent=false", "features.plugins=false", "features.hooks=false"]) expect(cfg).toContain(off);
  });

  it("CLI-SAME-ON-BOTH-PATHS an agent in its own container gets the turn's model and the closed shell too", async () => {
    const { Runner } = await import("./codex");
    const args = new Runner({ container: "tonoman-alpha", closedShell: true } as never).podmanArgs({ prompt: "hi", model: "luna" } as never);
    expect(args.slice(0, 3)).toEqual(["exec", "-i", "tonoman-alpha"]);
    expect(args.join(" ")).toContain("features.shell_tool=false");
    expect(args[args.indexOf("-m") + 1]).toContain("luna");
  });

  it("CLI-CLOSED-WHATEVER-FAILS is Tonoman Cloud's floor: a self-hosted agent, which codes in a container of its own, keeps its shell", async () => {
    const { Runner } = await import("./codex");
    const args = new Runner({ local: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t" } as never);
    expect(args.join(" ")).not.toContain("shell_tool");
  });

  it("CLI-TOKEN-NOT-IN-ARGUMENTS the turn's credential is nowhere on the Codex command line: tonoman's tool is told which variables to take from the turn's environment", async () => {
    const { Runner } = await import("./codex");
    const tool = { name: "tonoman", command: "/usr/bin/node", args: ["/opt/tonoman/tonoman-mcp.cjs"], env: { TONOMAN_BRAIN_URL: "http://127.0.0.1:9", TONOMAN_BRAIN_TOKEN: "s3cret-token" } };
    const args = new Runner({ local: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t", mcpServers: [tool] } as never);
    expect(args.join(" ")).not.toContain("s3cret-token");
    const cfg = args.filter((_, i) => args[i - 1] === "-c");
    expect(cfg).toContain('mcp_servers.tonoman.env_vars=["TONOMAN_BRAIN_URL","TONOMAN_BRAIN_TOKEN"]');
  });
});

describe("files the person attached", () => {
  it("CONVO-ATTACHED-FILES a Codex turn is handed the attached photos with --image, since it has no shell to open them", async () => {
    const { Runner } = await import("./codex");
    const args = new Runner({ local: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t", mediaPaths: ["/tmp/t/receipt.jpg", "/tmp/t/scan.PDF", "/tmp/t/photo.png"] } as never);
    const images = args.flatMap((a, i) => (a === "--image" ? [args[i + 1]] : []));
    expect(images).toEqual(["/tmp/t/receipt.jpg", "/tmp/t/photo.png"]);
  });
});

describe("when Codex fails, it says why", () => {
  it("CONVO-ERRORS-IN-PLAIN-WORDS an error Codex reports mid-turn keeps its message, and a failed turn is an error with that message", () => {
    const item = parseLine(JSON.stringify({ type: "item.completed", item: { id: "i", type: "error", message: "MCP client for `tonoman` failed to start" } }));
    expect(item).toMatchObject({ kind: "tool", tool: "error", text: "MCP client for `tonoman` failed to start" });
    const failed = parseLine(JSON.stringify({ type: "turn.failed", error: { message: "The 'x' model is not supported" } }));
    expect(failed?.kind).toBe("error");
    expect(failed && "err" in failed ? failed.err.message : "").toContain("The 'x' model is not supported");
  });
});

describe("a Codex conversation remembers (Tonoman Cloud docs/definition/objects/conversation.md)", () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  /** A session Codex has on disk: what `codex exec` leaves behind for a thread. */
  const onDisk = (h: string, thread: string) => {
    const d = path.join(h, "sessions", "2026", "09", "19");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `rollout-2026-09-19T20-00-00-${thread}.jsonl`), "{}\n");
  };

  it("CONVO-SESSION-RESUME the first message of a conversation starts a Codex session; nothing is resumed", async () => {
    const { Runner } = await import("./codex");
    const args = new Runner({ local: true } as never).codexTail({ prompt: "hi", cwd: "/tmp/t", sessionId: "s-1", sessionNew: true } as never);
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).not.toContain("resume");
  });

  it("CONVO-SESSION-RESUME a later message resumes Codex's own session for that conversation, with everything a turn is given still given", async () => {
    const { Runner } = await import("./codex");
    const args = new Runner({ local: true, closedShell: true } as never).codexTail(
      { prompt: "it was a client lunch", cwd: "/tmp/t2", sessionId: "s-1", sessionNew: false, model: "luna", mediaPaths: ["/tmp/t2/receipt.jpg"] } as never,
      false,
      "01a0bc8a-bbe1-77f3-9744-9d002f2a7f11",
    );
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.slice(-2)).toEqual(["01a0bc8a-bbe1-77f3-9744-9d002f2a7f11", "-"]); // the session, then the prompt from stdin
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args[args.indexOf("-m") + 1]).toContain("luna");
    expect(args.join(" ")).toContain("features.shell_tool=false");
    expect(args[args.indexOf("--image") + 1]).toBe("/tmp/t2/receipt.jpg");
    // `resume` takes no working folder: the process is started in it instead.
    expect(args).not.toContain("-C");
  });

  it("CONVO-SESSION-RESUME which Codex session belongs to which conversation is remembered beside that login, and forgotten when Codex no longer has it", async () => {
    const { rememberThread, threadFor } = await import("./codex");
    const h = home();
    expect(threadFor(h, "s-1")).toBeUndefined();
    onDisk(h, "01a0bc8a-aaaa");
    rememberThread(h, "s-1", "01a0bc8a-aaaa");
    rememberThread(h, "s-2", "01a0bc8a-gone"); // Codex has no record of this one
    expect(threadFor(h, "s-1")).toBe("01a0bc8a-aaaa");
    expect(threadFor(h, "s-2")).toBeUndefined();
    expect(threadFor(h, "../../etc/passwd")).toBeUndefined();
    fs.rmSync(h, { recursive: true, force: true });
  });
});
