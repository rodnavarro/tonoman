// What Astra's SECOND review of the turn-user code found (docs/definition/objects/turn-user.md in
// Tonoman Cloud): the worker still read, made and deleted by paths inside a user's folders in a few
// places; a run that failed to start was never counted as ended; a slow move could lose its lock to
// another. The half that needs Linux and root runs in the dev worker container; see launch.test.ts.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asTheUser, canDrop, commandFor, ensureUser, launchArgs, loginAsUser, looksLikeLogin, openToOthers, PROBE_UID, runBegan, runToEnd, stopAll, straysOf, sweepStrays } from "./launch";
import { __testing, bringHome, locked } from "./turnusers";
import { childEnv, runOnly } from "./turnenv";
import { identityPreamble, localEnv, parseTurnRollout, readTurnRolloutAs, threadForAs, rememberThread, usageFromRollout } from "./codex";

const tokenCount = (input: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input } }, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 60 } } } });

describe("what a run is given (pure)", () => {
  const ana = { uid: 20001, home: "/srv/tonoman/homes/20001" };

  it("TURNUSER-ONLY-WHAT-IT-NEEDS where a login is reaches the program only when it is handed over for this run — never because the worker's environment had it", () => {
    const worker = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/root/.claude", TONOMAN_BRAIN_TOKEN: "some-other-turns" };
    expect(commandFor(ana, "claude", ["-p"], worker).env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(commandFor(ana, "claude", ["-p"], worker).env).not.toHaveProperty("TONOMAN_BRAIN_TOKEN");
    const given = commandFor(ana, "claude", ["-p"], worker, { CLAUDE_CONFIG_DIR: `${ana.home}/agents/echo/claude` });
    expect(given.env.CLAUDE_CONFIG_DIR).toBe(`${ana.home}/agents/echo/claude`);
  });

  it("TURNUSER-ONLY-WHAT-IT-NEEDS a turn's tonoman credential is never picked out of an environment: it is handed over by name, from where it was made", () => {
    const built = { CODEX_HOME: "/h/codex", IS_SANDBOX: "1", TONOMAN_BRAIN_TOKEN: "whatever-the-worker-held", TONOMAN_BRAIN_URL: "http://127.0.0.1:1", SLACK_BOT_TOKEN: "xoxb" };
    expect(runOnly(built)).toEqual({ CODEX_HOME: "/h/codex", IS_SANDBOX: "1" });
  });

  it("TURNUSER-ROOT-STAYS-OUT a Codex turn's prompt is the words the worker read before the folder changed hands — the file is not opened again", () => {
    // A path that cannot be read stands in for a file that is no longer the worker's to open.
    expect(identityPreamble("/nonexistent/handed-over/.tonoman-system.md", "You are Echo.")).toContain("You are Echo.");
    expect(identityPreamble("/nonexistent/handed-over/.tonoman-system.md", "")).toBe("");
  });

  it("TURNUSER-ROOT-STAYS-OUT a Codex turn that runs as its own user does not have its login's folder made for it by the worker", () => {
    const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-")), "not-made");
    localEnv({ PATH: "/usr/bin" }, home, false);
    expect(fs.existsSync(home)).toBe(false);
    localEnv({ PATH: "/usr/bin" }, home);
    expect(fs.existsSync(home)).toBe(true);
  });

  it("CONVO-FOOTER-BOTH-PROVIDERS what a turn's record says is worked out from its text, wherever the text was read", () => {
    const text = [tokenCount(1200), "not json", tokenCount(3400)].join("\n");
    expect(parseTurnRollout(text)).toMatchObject({ modelCalls: 2, lastInput: 3400 });
    expect(usageFromRollout(text).length).toBeGreaterThan(0);
    expect(usageFromRollout("")).toEqual([]);
  });
});

describe("what a login is (pure)", () => {
  it("TURNUSER-MOVE-ONCE-SAFELY a login is the provider's own shape, by the file's name — not a file that is merely there, cut short, or some other JSON", () => {
    expect(looksLikeLogin("auth.json", '{"tokens":{"access_token":"eyJhbGciOi","refresh_token":"rt-0123456789"}}')).toBe(true);
    expect(looksLikeLogin("auth.json", '{"OPENAI_API_KEY":"sk-0123456789"}')).toBe(true);
    expect(looksLikeLogin(".credentials.json", '{"claudeAiOauth":{"accessToken":"sk-ant-oat-0123"}}')).toBe(true);
    for (const not of ["", "{", "[1]", '{"unrelated":true}', '{"tokens":{}}', '{"OPENAI_API_KEY":null,"tokens":{"access_token":""}}']) expect(looksLikeLogin("auth.json", not)).toBe(false);
    for (const not of ['{"claudeAiOauth":{}}', '{"tokens":{"access_token":"eyJhbGciOi"}}']) expect(looksLikeLogin(".credentials.json", not)).toBe(false);
  });
});

describe("one move of a login at a time", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "locks-"));

  it("TURNUSER-MOVE-ONCE-SAFELY two moves of the same login never run together, and one that fails does not hold the next one up", async () => {
    const root = dir();
    let inside = 0;
    let most = 0;
    const one = (fail = false) =>
      locked(root, "20001-codex", async () => {
        most = Math.max(most, ++inside);
        await new Promise((r) => setTimeout(r, 60));
        inside--;
        if (fail) throw new Error("this move failed");
      });
    const all = await Promise.allSettled([one(), one(true), one()]);
    expect(most).toBe(1);
    expect(all.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it.skipIf(process.platform !== "linux")("TURNUSER-MOVE-ONCE-SAFELY the lock is the kernel's: one held by a process that died is free at once, and one that is held is waited for, not taken", async () => {
    const root = dir();
    fs.mkdirSync(path.join(root, ".locks"), { recursive: true });
    const file = path.join(root, ".locks", "20001-codex");
    // In a group of its own, to be killed whole: `flock` hands the lock on to the program it starts.
    const holder = spawn("flock", ["-x", file, "sleep", "30"], { stdio: "ignore", detached: true });
    await new Promise((r) => setTimeout(r, 300));
    // Held by somebody alive: not taken over, however long it has been — waited for, then given up on.
    await expect(locked(root, "20001-codex", async () => "got it", 1000)).rejects.toThrow(/never finished/);
    process.kill(-holder.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    expect(await locked(root, "20001-codex", async () => "got it", 5000)).toBe("got it");
  }, 15_000);
});

describe("ending with the turn (pure)", () => {
  it("TURNUSER-DIES-WITH-THE-TURN what a finished run left behind is told from a run still going by whose child it is — not by its group or session, which it can leave", () => {
    const procs = [
      { pid: 100, ppid: 1, uid: 0 }, // the worker
      { pid: 200, ppid: 100, uid: 20001 }, // run B, still going
      { pid: 201, ppid: 200, uid: 20001 }, // B's tool
      { pid: 202, ppid: 201, uid: 20001 }, // …which started a session of its own: still B's
      { pid: 300, ppid: 1, uid: 20001 }, // left by run A, which has ended: nobody's
      { pid: 301, ppid: 300, uid: 20001 }, // and its child
      { pid: 400, ppid: 1, uid: 20002 }, // someone else's entirely
    ];
    expect(straysOf(procs, 20001, [200]).sort()).toEqual([300, 301]);
    // With no run still going, everything of that user's is a stray — and still nothing of anyone else's.
    expect(straysOf(procs, 20001, []).sort()).toEqual([200, 201, 202, 300, 301]);
  });

  it("TURNUSER-DIES-WITH-THE-TURN a group is never signalled by its number once its program has ended: by then the number may be somebody else's", () => {
    const sent: string[] = [];
    const real = process.kill;
    process.kill = ((pid: number, sig: string) => (sent.push(`${pid}:${sig}`), true)) as never;
    try {
      const ended = { pid: 4242, exitCode: null, signalCode: "SIGTERM" as const, kill: () => (sent.push("child.kill"), true) };
      stopAll(ended, true);
      stopAll(ended, true, "SIGKILL");
      const exited = { pid: 4243, exitCode: 0, signalCode: null, kill: () => (sent.push("child.kill"), true) };
      stopAll(exited, true);
      expect(sent).toEqual([]);
      const live = { pid: 4244, exitCode: null, signalCode: null, kill: () => true };
      stopAll(live, true, "SIGKILL");
      expect(sent).toEqual(["-4244:SIGKILL"]);
    } finally {
      process.kill = real;
    }
  });

  it("TURNUSER-ROOT-STAYS-OUT a program goes to its folder after it has become the user — the worker does not go there first, as root", () => {
    const l = launchArgs({ uid: 20001, home: "/srv/tonoman/homes/20001" }, "claude", ["-p"], "/srv/tonoman/turns/t-1");
    const at = l.args.indexOf("--");
    expect(l.args.slice(0, at).join(" ")).toContain("--reuid=20001");
    // After the drop: a shell that changes folder, then becomes the program.
    expect(l.args.slice(at + 1, at + 3)).toEqual(["sh", "-c"]);
    expect(l.args.slice(-3)).toEqual(["/srv/tonoman/turns/t-1", "claude", "-p"]);
    const c = commandFor({ uid: 20001, home: "/h" }, "claude", ["-p"], { PATH: "/usr/bin" }, {}, "/srv/tonoman/turns/t-1");
    expect(c.args).toContain("/srv/tonoman/turns/t-1");
  });

  it("TURNUSER-ONLY-WHAT-IT-NEEDS a Bedrock run gets the AWS settings it cannot run without, by name — not whatever the worker has that is called AWS_; and a proxy's password never rides in its address", () => {
    const worker = { PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1", AWS_SOMETHING_ELSE_SECRET: "no", HTTPS_PROXY: "http://user:pw@proxy:3128", HTTP_PROXY: "http://proxy:3128" };
    const env = childEnv(worker, { CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1", HTTP_PROXY: "http://proxy:3128" });
    expect(env).not.toHaveProperty("AWS_SOMETHING_ELSE_SECRET");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(childEnv(worker, {})).not.toHaveProperty("AWS_ACCESS_KEY_ID");
  });
});

// The real thing: Linux, as root, with setpriv. Anywhere else these are skipped, and say so.
describe.skipIf(!canDrop())("root stays out, second pass (Linux, root)", () => {
  fs.mkdirSync("/srv", { recursive: true });
  const root = fs.mkdtempSync("/srv/tonoman-pass2-test-");
  fs.chmodSync(root, 0o711);
  const homes = path.join(root, "homes");
  const as = (user: { uid: number; home: string }, script: string): Promise<string> =>
    new Promise((resolve) => {
      const { cmd, args } = launchArgs(user, "sh", ["-c", script]);
      const c = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: user.home } });
      let out = "";
      c.stdout.on("data", (b) => (out += b));
      c.stderr.on("data", (b) => (out += b));
      c.on("close", () => resolve(out));
    });
  const alive = (pid: number): boolean => {
    try {
      return !/^\S+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  };

  it("TURNUSER-MOVE-ONCE-SAFELY bringing a login home deletes nothing that is there and writes over nothing: what the user has stays, whatever the old login held", async () => {
    const dan = await ensureUser(29301, homes);
    const configHome = path.join(dan.home, "agents", "echo", "codex");
    await as(dan, `mkdir -p ${configHome}/sessions && echo mine > ${configHome}/config.toml && echo kept > ${configHome}/sessions/today.jsonl`);
    const old = path.join(root, "old", "echo", "users", "UDAN");
    fs.mkdirSync(path.join(old, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"dans-access-token"}}');
    fs.writeFileSync(path.join(old, "config.toml"), "the old one");
    fs.writeFileSync(path.join(old, "sessions", "last-year.jsonl"), "{}");
    expect(await bringHome(dan, configHome, old, "auth.json", () => {})).toBe(true);
    expect(fs.readFileSync(path.join(configHome, "config.toml"), "utf8")).toBe("mine\n");
    expect(fs.readFileSync(path.join(configHome, "sessions", "today.jsonl"), "utf8")).toBe("kept\n");
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"dans-access-token"}}');
    expect(fs.existsSync(path.join(configHome, "sessions", "last-year.jsonl"))).toBe(true);
    for (const f of ["auth.json", "sessions/last-year.jsonl"]) {
      const st = fs.lstatSync(path.join(configHome, f));
      expect(st.uid).toBe(29301);
      expect(st.mode & 0o077).toBe(0);
    }
    // The copy it came from is gone, and was never the user's.
    expect(fs.readdirSync(path.join(homes, ".staging"))).toEqual([]);
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a login made at home while the old one was on its way is what stays", async () => {
    const fay = await ensureUser(29302, homes);
    const configHome = path.join(fay.home, "agents", "echo", "codex");
    fs.writeFileSync(path.join(root, "fresh.json"), '{"tokens":{"access_token":"fresh-access-token"}}');
    fs.chmodSync(path.join(root, "fresh.json"), 0o644);
    await as(fay, `mkdir -p ${configHome} && cp ${root}/fresh.json ${configHome}/auth.json`);
    const old = path.join(root, "old", "echo", "users", "UFAY");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"stale-access-token"}}');
    expect(await bringHome(fay, configHome, old, "auth.json", () => {})).toBe(false);
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"fresh-access-token"}}');
    expect(fs.existsSync(old)).toBe(true);
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a credential file that is merely there — left empty by a sign-in that never finished — is not a login, and does not stand in the way of the real one for ever; it is kept aside, not deleted", async () => {
    const gus = await ensureUser(29312, homes);
    const configHome = path.join(gus.home, "agents", "echo", "codex");
    await as(gus, `mkdir -p ${configHome} && : > ${configHome}/auth.json && echo kept > ${configHome}/history.jsonl`);
    const old = path.join(root, "old", "echo", "users", "UGUS");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"guss-access-token"}}');
    expect(await bringHome(gus, configHome, old, "auth.json", () => {})).toBe(true);
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"guss-access-token"}}');
    expect(fs.readFileSync(path.join(configHome, "history.jsonl"), "utf8")).toBe("kept\n");
    const beside = fs.readdirSync(configHome).filter((n) => n.startsWith("auth.json.not-a-login."));
    expect(beside).toHaveLength(1);
    expect(fs.readFileSync(path.join(configHome, beside[0]!), "utf8")).toBe("");
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a login is put in place by one rename of the whole folder, so its files may be called anything — a name with a line break in it included", async () => {
    const ann = await ensureUser(29313, homes);
    const configHome = path.join(ann.home, "agents", "echo", "codex");
    const old = path.join(root, "old", "echo", "users", "UANN");
    fs.mkdirSync(path.join(old, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"anns-access-token"}}');
    fs.writeFileSync(path.join(old, "sessions", "a\nb.jsonl"), "odd");
    expect(await bringHome(ann, configHome, old, "auth.json", () => {})).toBe(true);
    expect(fs.readFileSync(path.join(configHome, "sessions", "a\nb.jsonl"), "utf8")).toBe("odd");
  });

  it("TURNUSER-ROOT-STAYS-OUT whether a login is already home is asked as the user: a link to one of root's files, planted where the credential goes, is not a login", async () => {
    const mal = await ensureUser(29303, homes);
    const secret = path.join(root, "roots-auth.json");
    fs.writeFileSync(secret, "root's", { mode: 0o600 });
    const configHome = path.join(mal.home, "agents", "echo", "codex");
    await as(mal, `mkdir -p ${configHome} && ln -s ${secret} ${configHome}/auth.json`);
    const old = path.join(root, "old", "echo", "users", "UMAL2");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"mals-access-token"}}');
    await bringHome(mal, configHome, old, "auth.json", () => {}).catch(() => false);
    expect(fs.readFileSync(secret, "utf8")).toBe("root's");
    expect(fs.lstatSync(secret).uid).toBe(0);
  });

  it("TURNUSER-ROOT-STAYS-OUT a Codex turn's record is found and read as the user: a link planted where a record goes shows nothing of root's", async () => {
    const gil = await ensureUser(29304, homes);
    const codexHome = path.join(gil.home, "agents", "echo", "codex");
    const day = `${codexHome}/sessions/2026/09/20`;
    const secret = path.join(root, "a-secret.jsonl");
    fs.writeFileSync(secret, tokenCount(999_999), { mode: 0o600 });
    await as(gil, `mkdir -p ${day} && ln -s ${secret} ${day}/rollout-2026-thread-evil.jsonl`);
    fs.writeFileSync(path.join(root, "real.jsonl"), [tokenCount(1200), tokenCount(3400)].join("\n"));
    fs.chmodSync(path.join(root, "real.jsonl"), 0o644);
    await as(gil, `cp ${root}/real.jsonl ${day}/rollout-2026-thread-good.jsonl`);
    expect(await readTurnRolloutAs(gil, codexHome, "thread-evil")).toBeUndefined();
    expect(await readTurnRolloutAs(gil, codexHome, "thread-good")).toMatchObject({ modelCalls: 2, lastInput: 3400 });
    // And which session a conversation is, is remembered where the user cannot write it.
    const mapDir = path.join(root, "codex-threads");
    rememberThread(codexHome, "sess-1", "thread-good", mapDir);
    rememberThread(codexHome, "sess-2", "thread-evil", mapDir);
    expect(await threadForAs(gil, codexHome, "sess-1", mapDir)).toBe("thread-good");
    expect(await threadForAs(gil, codexHome, "sess-2", mapDir)).toBeUndefined();
  });

  it("TURNUSER-DIES-WITH-THE-TURN a run is counted as ended exactly once, however many times it is said to have ended; and what it left behind is stopped at once — while another run of the same user goes on, untouched", async () => {
    const hal = await ensureUser(29305, homes);
    const runA = await runBegan(hal);
    const runB = await runBegan(hal);
    const start = (script: string) => {
      const { cmd, args } = launchArgs(hal, "sh", ["-c", script]);
      return spawn(cmd, args, { env: { PATH: process.env.PATH }, detached: true, stdio: "ignore" });
    };
    // Run B: a program and its child, going on. Run A: starts something in a session of its own, and ends.
    const b = start("sleep 30 & wait");
    runB.started(b.pid);
    const a = start("setsid sh -c 'echo $$ > " + hal.home + "/escaped.pid; sleep 30' & sleep 0.3");
    runA.started(a.pid);
    await new Promise((r) => a.once("exit", r));
    const escaped = Number(fs.readFileSync(path.join(hal.home, "escaped.pid"), "utf8"));
    expect(alive(escaped)).toBe(true);
    // A start that failed AND an exit, both reported: still one run ended.
    runA.release();
    runA.release();
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(escaped)).toBe(false); // A's stray: gone, though B is still going
    expect(alive(b.pid!)).toBe(true); // B: untouched
    runB.release();
    b.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(b.pid!)).toBe(false);
  });

  it("TURNUSER-ROOT-STAYS-OUT a turn's folder swapped for a link into a place its user may not enter gets the program nowhere: it goes there as the user, and cannot", async () => {
    const kim = await ensureUser(29308, homes);
    const vault = path.join(root, "vault");
    fs.mkdirSync(path.join(vault, "inner"), { recursive: true });
    fs.chmodSync(path.join(vault, "inner"), 0o755); // open itself — guarded only by the folder above it
    fs.chmodSync(vault, 0o700);
    fs.writeFileSync(path.join(vault, "inner", "secret"), "root's");
    fs.chmodSync(path.join(vault, "inner", "secret"), 0o644);
    const turn = path.join(kim.home, "turn");
    await as(kim, `ln -s ${vault}/inner ${turn}`);
    const { cmd, args } = launchArgs(kim, "cat", ["secret"], turn);
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      // NOT spawn's `cwd`: that would be root walking through the link first.
      const c = spawn(cmd, args, { env: { PATH: process.env.PATH } });
      let text = "";
      c.stdout.on("data", (d) => (text += d));
      c.on("close", (code) => resolve({ code, text }));
    });
    expect(out.text).not.toContain("root's");
    expect(out.code).toBe(97);
  });

  it("TURNUSER-DIES-WITH-THE-TURN a helper run as a user has a real deadline: one that is stopped in its tracks is killed, not waited for", async () => {
    const lee = await ensureUser(29309, homes);
    const began = Date.now();
    await expect(asTheUser(lee, "kill -STOP $$; echo never", [], { timeoutMs: 1500 })).rejects.toThrow(/in time/);
    expect(Date.now() - began).toBeLessThan(6000);
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a move cut short before the login is in place leaves NO login at home and a home that is otherwise as it was, or fuller — never missing — and is simply done again", async () => {
    const mo = await ensureUser(29310, homes);
    const configHome = path.join(mo.home, "agents", "echo", "codex");
    await as(mo, `mkdir -p ${configHome} && echo mine > ${configHome}/config.toml`);
    const old = path.join(root, "old", "echo", "users", "UMO");
    fs.mkdirSync(path.join(old, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"mos-access-token"}}');
    fs.writeFileSync(path.join(old, "sessions", "a.jsonl"), "{}");
    // The first half only, as if the worker had been stopped right after it.
    const copy = path.join(root, "mo-copy");
    fs.cpSync(old, copy, { recursive: true });
    fs.chmodSync(copy, 0o755);
    fs.chmodSync(path.join(copy, "sessions"), 0o755);
    for (const f of ["auth.json", "sessions/a.jsonl"]) fs.chmodSync(path.join(copy, f), 0o644);
    expect((await asTheUser(mo, __testing.PREPARE, [copy, configHome, "auth.json"])).trim()).toBe("merged");
    expect(fs.existsSync(configHome)).toBe(true); // the home is there
    expect(fs.existsSync(path.join(configHome, "auth.json"))).toBe(false); // and holds no login
    expect(fs.readFileSync(path.join(configHome, "config.toml"), "utf8")).toBe("mine\n");
    // Done again, from the start, it goes through.
    expect(await bringHome(mo, configHome, old, "auth.json", () => {})).toBe(true);
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toContain("mos-access-token");
    expect(fs.existsSync(path.join(configHome, "sessions", "a.jsonl"))).toBe(true);
    expect(fs.readdirSync(path.dirname(configHome)).filter((n) => n.includes("incoming"))).toEqual([]);
  });

  it("TURNUSER-DOORS-TRIED-AT-START a door can be open to one user and shut to everyone else: each real user tries them too; and a folder above a door that a user can write is a door", async () => {
    const ned = await ensureUser(29311, homes);
    const place = path.join(root, "neds-by-mistake");
    // Root's own, but let to this one user's GROUP by mistake: nobody else gets in.
    fs.mkdirSync(place, { mode: 0o750 });
    fs.writeFileSync(path.join(place, "token"), "x", { mode: 0o640 });
    fs.chownSync(place, 0, 29311);
    fs.chownSync(path.join(place, "token"), 0, 29311);
    expect(await openToOthers([place])).toEqual([]); // shut to the throwaway plain user
    expect(await openToOthers([place], [], { as: ned })).toEqual([place]); // open to the one it matters for
    // Closed itself, but in a folder anyone can write: whoever can write that can put another in its place.
    const loose = path.join(root, "loose");
    fs.mkdirSync(path.join(loose, "code"), { recursive: true });
    fs.chmodSync(path.join(loose, "code"), 0o755);
    fs.chmodSync(loose, 0o777);
    expect(await openToOthers([], [path.join(loose, "code")])).toEqual([path.join(loose, "code")]);
    // And code reached through a link is checked where the link leads.
    const real = path.join(root, "real-code");
    fs.mkdirSync(real, { mode: 0o755 });
    fs.writeFileSync(path.join(real, "run.js"), "x");
    fs.chmodSync(path.join(real, "run.js"), 0o666);
    const tree = path.join(root, "tree");
    fs.mkdirSync(tree, { mode: 0o755 });
    fs.symlinkSync(real, path.join(tree, "lib"));
    expect(await openToOthers([], [tree])).toEqual([tree]);
  });

  it("TURNUSER-DOORS-TRIED-AT-START a file a user may change and not read, in a folder it cannot list, is a door; and a door that is itself a link is looked at where it leads", async () => {
    const ola = await ensureUser(29314, homes);
    const state = path.join(root, "state");
    fs.mkdirSync(state, { mode: 0o711 }); // passable, not listable: its own `find` sees nothing in it
    fs.writeFileSync(path.join(state, "owners.json"), "{}");
    fs.chownSync(path.join(state, "owners.json"), 0, 29314);
    fs.chmodSync(path.join(state, "owners.json"), 0o620); // its group may write it, and not read it
    expect(await openToOthers([state])).toEqual([]);
    expect(await openToOthers([state], [], { as: ola })).toEqual([state]);
    // The same place, named by a link to it.
    const link = path.join(root, "state-link");
    fs.symlinkSync(state, link);
    expect(await openToOthers([link], [], { as: ola })).toEqual([link]);
    // And a place root has shut altogether holds nothing anyone can reach, whatever is in it.
    const shut = path.join(root, "shut");
    fs.mkdirSync(shut, { mode: 0o700 });
    fs.writeFileSync(path.join(shut, "wide-open"), "x");
    fs.chmodSync(path.join(shut, "wide-open"), 0o666);
    expect(await openToOthers([shut], [], { as: ola })).toEqual([]);
  });

  it("TURNUSER-DIES-WITH-THE-TURN runs ending one on top of another are cleaned up by ONE sweep, and a run let in afterwards is never what an older pass stops", async () => {
    const pat = await ensureUser(29315, homes);
    const start = (script: string) => {
      const { cmd, args } = launchArgs(pat, "sh", ["-c", script]);
      return spawn(cmd, args, { env: { PATH: process.env.PATH }, detached: true, stdio: "ignore" });
    };
    const holds = [await runBegan(pat), await runBegan(pat), await runBegan(pat)];
    const procs = holds.map((h) => {
      const c = start("setsid sleep 30 & sleep 30");
      h.started(c.pid);
      return c;
    });
    await new Promise((r) => setTimeout(r, 300));
    // All three end at once: their programs are stopped, and each says so.
    for (const c of procs) process.kill(-c.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    for (const h of holds) h.release();
    // A new run asks to start straight away: it waits for the sweep, and then it is left alone.
    const next = await runBegan(pat);
    const c = start("exec sleep 30"); // one process, so that anything else of this user's is a stray
    next.started(c.pid);
    await new Promise((r) => setTimeout(r, 1200));
    expect(alive(c.pid!)).toBe(true);
    const left = fs.readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d) && d !== String(c.pid) && (() => { try { return fs.statSync(`/proc/${d}`).uid === 29315 && alive(Number(d)); } catch { return false; } })());
    expect(left).toEqual([]); // the three `setsid sleep`s that had escaped their groups: gone
    process.kill(-c.pid!, "SIGKILL");
    next.release();
  });

  it("TURNUSER-DIES-WITH-THE-TURN a clean-up that cannot be KNOWN to have happened is not one: a sweeper that never got to run says nothing, and quiet looks are not taken for it", async () => {
    const ray = await ensureUser(29317, homes);
    // The sweeper is node, started as the user. With no node to start, the kill never happens —
    // and although nothing of this user's is running, so every look is quiet, that is not success.
    const realExec = process.execPath;
    Object.defineProperty(process, "execPath", { value: "/nonexistent/node", configurable: true });
    try {
      await expect(sweepStrays(ray, [])).rejects.toThrow(/could not be stopped/);
    } finally {
      Object.defineProperty(process, "execPath", { value: realExec, configurable: true });
    }
    await expect(sweepStrays(ray, [])).resolves.toBeUndefined();
  });

  it("TURNUSER-MOVE-ONCE-SAFELY what the home holds stays exactly as it is; a link planted where the login goes is replaced, never written through; and a move cut short before the login is in place is simply done again", async () => {
    const sam = await ensureUser(29318, homes);
    const configHome = path.join(sam.home, "agents", "echo", "codex");
    // The home: a file of its own, and — where the login goes — a link to another of its own files.
    await as(sam, `mkdir -p ${configHome} && echo mine > ${configHome}/config.toml && echo precious > ${sam.home}/precious.txt && ln -s ${sam.home}/precious.txt ${configHome}/auth.json`);
    const old = path.join(root, "old", "echo", "users", "USAM");
    fs.mkdirSync(path.join(old, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"sams-access-token"}}');
    fs.writeFileSync(path.join(old, "config.toml"), "the old one");
    fs.writeFileSync(path.join(old, "sessions", "a.jsonl"), "{}");
    expect(await bringHome(sam, configHome, old, "auth.json", () => {})).toBe(true);
    expect(fs.readFileSync(path.join(sam.home, "precious.txt"), "utf8")).toBe("precious\n"); // not written through the link
    expect(fs.lstatSync(path.join(configHome, "auth.json")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toContain("sams-access-token");
    expect(fs.readFileSync(path.join(configHome, "config.toml"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(configHome, "sessions", "a.jsonl"))).toBe(true);
    expect(fs.existsSync(`${configHome}.incoming`)).toBe(false);
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a person who signs in while their old login is being copied keeps the login they just made", async () => {
    const tia = await ensureUser(29319, homes);
    const configHome = path.join(tia.home, "agents", "echo", "codex");
    await as(tia, `mkdir -p ${configHome} && echo state > ${configHome}/state.sqlite`);
    const old = path.join(root, "old", "echo", "users", "UTIA");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"stale-access-token"}}');
    // Enough to copy that the sign-in lands while the copy is under way.
    for (let i = 0; i < 900; i++) fs.writeFileSync(path.join(old, `blob-${i}`), Buffer.alloc(64 * 1024, i));
    fs.writeFileSync(path.join(root, "fresh-tia.json"), '{"tokens":{"access_token":"fresh-access-token"}}');
    fs.chmodSync(path.join(root, "fresh-tia.json"), 0o644);
    const moving = bringHome(tia, configHome, old, "auth.json", () => {});
    await new Promise((r) => setTimeout(r, 60));
    await as(tia, `cp ${root}/fresh-tia.json ${configHome}/auth.json`);
    expect(await moving).toBe(false);
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toContain("fresh-access-token");
    expect(fs.existsSync(old)).toBe(true); // not set aside: it never came home
    expect(fs.existsSync(`${configHome}.incoming`)).toBe(false);
  });

  it("TURNUSER-DOORS-TRIED-AT-START something in a closed place that belongs to a turn user is a door, however shut it looks today: its owner can open it whenever it likes", async () => {
    const una = await ensureUser(29320, homes);
    const state = path.join(root, "state-owned");
    fs.mkdirSync(path.join(state, "known-child"), { recursive: true });
    fs.chmodSync(state, 0o711);
    fs.chownSync(path.join(state, "known-child"), 29320, 29320);
    fs.chmodSync(path.join(state, "known-child"), 0o100); // no write, no read — today
    expect(await openToOthers([state], [], { as: una })).toEqual([state]);
    expect(await openToOthers([state])).toEqual([state]); // …and to anyone checking: it is some turn user's
  });

  it("TURNUSER-DOORS-TRIED-AT-START whoever owns a thing can open it: a door that is ITSELF a user's, something of the throwaway plain user's, and a read-only file of a user's in what a turn runs, are all doors", async () => {
    const vic = await ensureUser(29321, homes);
    // The closed place itself belongs to a turn user, shut tight and empty — today.
    const own = path.join(root, "own-door");
    fs.mkdirSync(own, { mode: 0o100 });
    fs.chownSync(own, 29321, 29321);
    expect(await openToOthers([own])).toEqual([own]);
    expect(await openToOthers([own], [], { as: vic })).toEqual([own]);
    // Something in a closed place that is the throwaway plain user's: it runs programs too.
    const st = path.join(root, "state-probe");
    fs.mkdirSync(path.join(st, "child"), { recursive: true });
    fs.chmodSync(st, 0o711);
    fs.chownSync(path.join(st, "child"), PROBE_UID, PROBE_UID);
    fs.chmodSync(path.join(st, "child"), 0o100);
    expect(await openToOthers([st])).toEqual([st]);
    // What a turn runs: a file nobody can write today, but that is a user's own.
    const code = path.join(root, "code");
    fs.mkdirSync(code, { mode: 0o755 });
    fs.writeFileSync(path.join(code, "run.js"), "x");
    fs.chownSync(path.join(code, "run.js"), 29321, 29321);
    fs.chmodSync(path.join(code, "run.js"), 0o444);
    expect(await openToOthers([], [code])).toEqual([code]);
    // And the same tree, all root's: closed.
    fs.chownSync(path.join(code, "run.js"), 0, 0);
    expect(await openToOthers([], [code])).toEqual([]);
  });

  it("TURNUSER-MOVE-ONCE-SAFELY what is judged and what is compared are ONE look at the same bytes; a file too big to judge is not judged by its beginning; and not being able to look is never taken to mean there is no login", async () => {
    const wes = await ensureUser(29322, homes);
    const configHome = path.join(wes.home, "agents", "echo", "codex");
    const atHome = path.join(configHome, "auth.json");
    const old = path.join(root, "old", "echo", "users", "UWES");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"stale-access-token"}}');
    // A login to begin with, a megabyte of padding, and then rubbish: not a login, whatever its first bytes say.
    fs.writeFileSync(path.join(root, "big.json"), '{"tokens":{"access_token":"looks-fine-token"}}' + " ".repeat((1 << 20) - 46) + "}}}garbage");
    fs.chmodSync(path.join(root, "big.json"), 0o644);
    await as(wes, `mkdir -p ${configHome} && cp ${root}/big.json ${atHome}`);
    expect(await loginAsUser(wes, atHome)).toEqual({ login: false, was: "other:too-big" });
    await expect(bringHome(wes, configHome, old, "auth.json", () => {})).rejects.toThrow(/too large/);
    expect(fs.statSync(atHome).size).toBeGreaterThan(1 << 20); // left exactly as it was
    // A real login: seen as one, and named by its bytes.
    await as(wes, `printf '%s' '{"tokens":{"access_token":"wes-access-token"}}' > ${atHome}`);
    const seen = await loginAsUser(wes, atHome);
    expect(seen.login).toBe(true);
    expect(seen.was).toMatch(/^file:[0-9a-f]{64}$/);
    // One that cannot be read at all: that is an error, never "no login here" — it is not replaced.
    await as(wes, `chmod 000 ${atHome}`);
    await expect(loginAsUser(wes, atHome)).rejects.toThrow();
    await expect(bringHome(wes, configHome, old, "auth.json", () => {})).rejects.toThrow();
    await as(wes, `chmod 600 ${atHome}`);
    expect(fs.readFileSync(atHome, "utf8")).toContain("wes-access-token");
    expect(fs.existsSync(old)).toBe(true);
    // Nothing there, and a link, are told apart too.
    await as(wes, `rm ${atHome} && ln -s /etc/hostname ${atHome}`);
    expect(await loginAsUser(wes, atHome)).toEqual({ login: false, was: "other:link:/etc/hostname" });
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a file is put in place by a link, which fails rather than replace: something written at home under the same name is what stays, and what was there and was no login is kept under a name that was free", async () => {
    const xia = await ensureUser(29323, homes);
    const configHome = path.join(xia.home, "agents", "echo", "codex");
    await as(xia, `mkdir -p ${configHome}/sessions && echo home > ${configHome}/sessions/a.jsonl && echo broken > ${configHome}/auth.json`);
    const old = path.join(root, "old", "echo", "users", "UXIA");
    fs.mkdirSync(path.join(old, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"xias-access-token"}}');
    fs.writeFileSync(path.join(old, "sessions", "a.jsonl"), "old");
    fs.writeFileSync(path.join(old, "sessions", "b.jsonl"), "old-b");
    expect(await bringHome(xia, configHome, old, "auth.json", () => {})).toBe(true);
    expect(fs.readFileSync(path.join(configHome, "sessions", "a.jsonl"), "utf8")).toBe("home\n");
    expect(fs.readFileSync(path.join(configHome, "sessions", "b.jsonl"), "utf8")).toBe("old-b");
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toContain("xias-access-token");
    const aside = fs.readdirSync(configHome).filter((n) => n.startsWith("auth.json.not-a-login."));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(configHome, aside[0]!), "utf8")).toBe("broken\n");
  });

  it("TURNUSER-DIES-WITH-THE-TURN after a clean-up that failed, nothing new is started as that user — a helper no more than a run — until one has worked", async () => {
    const yan = await ensureUser(29324, homes);
    const hold = await runBegan(yan);
    hold.started(undefined);
    const realExec = process.execPath;
    Object.defineProperty(process, "execPath", { value: "/nonexistent/node", configurable: true });
    try {
      hold.release(); // the sweep this starts cannot run its sweeper: it fails
      await new Promise((r) => setTimeout(r, 1500));
      await expect(asTheUser(yan, "echo hi")).rejects.toThrow(/could not be stopped/);
      await expect(runBegan(yan)).rejects.toThrow(/could not be stopped/);
    } finally {
      Object.defineProperty(process, "execPath", { value: realExec, configurable: true });
    }
    // Once a clean-up works again, so does everything else.
    expect((await asTheUser(yan, "echo hi")).trim()).toBe("hi");
  }, 20_000);

  it("TURNUSER-DIES-WITH-THE-TURN a provider's status check is a counted run with a real deadline: everything it said comes back however it ended, and what it left behind is stopped", async () => {
    const quin = await ensureUser(29316, homes);
    const l = launchArgs(quin, "sh", ["-c", "setsid sleep 30 & echo Not logged in; echo why >&2; exit 3"]);
    const said = await runToEnd(quin, l.cmd, l.args, { PATH: process.env.PATH }, 5000);
    expect(said).toContain("Not logged in");
    expect(said).toContain("why");
    await new Promise((r) => setTimeout(r, 1200));
    const left = fs.readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d) && (() => { try { return fs.statSync(`/proc/${d}`).uid === 29316 && alive(Number(d)); } catch { return false; } })());
    expect(left).toEqual([]);
  });

  it("TURNUSER-HOME-PRIVATE a home the worker had made and not yet handed over when it last stopped is finished, not refused for ever; one that holds anything is not adopted", async () => {
    fs.mkdirSync(homes, { recursive: true });
    fs.mkdirSync(path.join(homes, "29306"), { mode: 0o700 });
    const ivy = await ensureUser(29306, homes);
    expect(fs.lstatSync(ivy.home).uid).toBe(29306);
    fs.mkdirSync(path.join(homes, "29307"), { mode: 0o700 });
    fs.writeFileSync(path.join(homes, "29307", "something"), "root's");
    await expect(ensureUser(29307, homes)).rejects.toThrow(/belongs to someone else/);
  });
});
