// What Astra's review of the turn-user code found, each proven here before it was fixed
// (docs/definition/objects/turn-user.md in Tonoman Cloud: TURNUSER-ROOT-STAYS-OUT,
// TURNUSER-ONLY-WHAT-IT-NEEDS, TURNUSER-DIES-WITH-THE-TURN, TURNUSER-DOORS-TRIED-AT-START).
// The half that needs Linux and root runs in the dev worker container; see launch.test.ts.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { canDrop, commandFor, ensureUser, launchArgs, openToOthers, sweepUser, giveFresh, readAsUser, removeAsUser, shareForCopy, PROBE_UID } from "./launch";
import { bringHome } from "./turnusers";
import { childEnv } from "./turnenv";

describe("a program started as a user gets an environment made for it (pure)", () => {
  const worker = {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    TZ: "America/New_York",
    HTTPS_PROXY: "http://proxy:3128",
    // Looks harmless by name, and the old deny-list let it through on purpose:
    CLAUDE_CODE_OAUTH_TOKEN: "the-whole-pools-login",
    TONOMANCLOUD_API_TOKEN: "sys-secret",
    // A secret nobody thought to give a secret-looking name:
    GIT_ASKPASS_HELPER_VALUE: "ado-pat",
    TONOMAN_STATE_ROOT: "/root/.tonoman",
    TEMPORAL_ADDRESS: "temporal:7233",
  };

  it("TURNUSER-ONLY-WHAT-IT-NEEDS what it is given is a list of what it needs, not the worker's environment with some names removed", () => {
    const env = childEnv(worker, { CODEX_HOME: "/srv/tonoman/homes/20001/agents/echo/codex", TONOMAN_BRAIN_TOKEN: "this-turns-own" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      TZ: "America/New_York",
      HTTPS_PROXY: "http://proxy:3128",
      CODEX_HOME: "/srv/tonoman/homes/20001/agents/echo/codex",
      TONOMAN_BRAIN_TOKEN: "this-turns-own",
    });
  });

  it("TURNUSER-ONLY-WHAT-IT-NEEDS the pool's own Claude login, and where the platform's services are, never ride along", () => {
    const c = commandFor({ uid: 20001, home: "/srv/tonoman/homes/20001" }, "claude", ["-p"], worker, { CLAUDE_CONFIG_DIR: "/srv/tonoman/homes/20001/agents/echo/claude" });
    const s = JSON.stringify(c.env);
    for (const leak of ["sk-ant-oat", "sys-secret", "ado-pat", "temporal:7233", "/root/.tonoman"]) expect(s).not.toContain(leak);
    expect(c.env).toMatchObject({ HOME: "/srv/tonoman/homes/20001", CLAUDE_CONFIG_DIR: "/srv/tonoman/homes/20001/agents/echo/claude" });
  });

  it("TURNUSER-ONLY-WHAT-IT-NEEDS a Bedrock agent still gets the AWS credentials it cannot run without — and only then", () => {
    const aws = { ...worker, AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1" };
    expect(childEnv(aws, { CLAUDE_CODE_USE_BEDROCK: "1" })).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "us-east-1" });
    expect(Object.keys(childEnv(aws, {})).some((k) => k.startsWith("AWS_"))).toBe(false);
  });
});

describe.skipIf(!canDrop())("root stays out of a user's folders (Linux, root)", () => {
  fs.mkdirSync("/srv", { recursive: true });
  const root = fs.mkdtempSync("/srv/tonoman-hardening-test-");
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
  const ownerOf = (p: string) => fs.lstatSync(p).uid;

  it("TURNUSER-ROOT-STAYS-OUT a user who swaps a folder in its home for a link to somewhere else gains nothing: the login is brought home without root following it", async () => {
    const mallory = await ensureUser(29201, homes);
    const victim = path.join(root, "roots-own");
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(path.join(victim, "keep.txt"), "root's file", { mode: 0o600 });
    // Where the login would go is a link out of the home, planted by the user itself.
    await as(mallory, `mkdir -p ${mallory.home}/agents && ln -s ${victim} ${mallory.home}/agents/echo`);
    const old = path.join(root, "old", "echo", "users", "UMAL");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"mallorys-access-token"}}');
    await bringHome(mallory, path.join(mallory.home, "agents", "echo", "codex"), old, "auth.json").catch(() => false);
    // Whatever happened to the move, nothing of root's changed hands or was written into.
    expect(ownerOf(victim)).toBe(0);
    expect(ownerOf(path.join(victim, "keep.txt"))).toBe(0);
    expect(fs.readdirSync(victim)).toEqual(["keep.txt"]);
  });

  it("TURNUSER-ROOT-STAYS-OUT a tree the worker hands over is one only the worker could have touched: anything else is refused, never re-owned", async () => {
    const eve = await ensureUser(29202, homes);
    const fresh = fs.mkdtempSync(path.join(root, "turn-"));
    fs.writeFileSync(path.join(fresh, "receipt.jpg"), "photo");
    await giveFresh(eve, fresh);
    expect(ownerOf(path.join(fresh, "receipt.jpg"))).toBe(29202);
    // The same folder again, now the user's: a second hand-over must not walk it as root.
    const target = path.join(root, "not-yours");
    fs.writeFileSync(target, "root's", { mode: 0o600 });
    await as(eve, `ln -s ${target} ${fresh}/planted`);
    await expect(giveFresh(eve, fresh)).rejects.toThrow(/already/);
    expect(ownerOf(target)).toBe(0);
  });

  it("TURNUSER-DIES-WITH-THE-TURN a program that detaches itself into a session of its own does not outlive its user's last turn", async () => {
    const dan = await ensureUser(29203, homes);
    await as(dan, "setsid sh -c 'sleep 300' >/dev/null 2>&1 & sleep 0.3");
    const alive = () =>
      fs.readdirSync("/proc").filter((p) => {
        if (!/^[0-9]+$/.test(p)) return false;
        try {
          return fs.statSync(`/proc/${p}`).uid === 29203 && fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
        } catch {
          return false;
        }
      }).length;
    expect(alive()).toBeGreaterThanOrEqual(1); // it escaped the turn's own group
    await sweepUser(dan);
    expect(alive()).toBe(0);
  });

  it("TURNUSER-DOORS-TRIED-AT-START a folder a plain user can pass through to a file it can read is open, however closed the folder itself looks", async () => {
    const passable = path.join(root, "passable-secrets");
    fs.mkdirSync(passable);
    fs.chmodSync(passable, 0o711); // cannot be listed…
    fs.writeFileSync(path.join(passable, "slack-bot-token"), "xoxb");
    fs.chmodSync(path.join(passable, "slack-bot-token"), 0o644); // …but a file in it can be read by name
    const sealed = path.join(root, "sealed-secrets");
    fs.mkdirSync(sealed);
    fs.chmodSync(sealed, 0o755); // Kubernetes' own shape: the folder is open, the files are root's alone
    fs.writeFileSync(path.join(sealed, "slack-bot-token"), "xoxb");
    fs.chmodSync(path.join(sealed, "slack-bot-token"), 0o400);
    expect(await openToOthers([passable, sealed])).toEqual([passable]);
  });

  it("TURNUSER-DOORS-TRIED-AT-START what a turn runs must not be a turn's to change: a writable source or tools folder is a door too", async () => {
    const tools = path.join(root, "tools");
    fs.mkdirSync(tools);
    fs.chmodSync(tools, 0o777);
    const sound = path.join(root, "tools-ok");
    fs.mkdirSync(sound);
    fs.chmodSync(sound, 0o755);
    expect(await openToOthers([], [tools, sound])).toEqual([tools]);
  });

  it("TURNUSER-ROOT-STAYS-OUT what the worker reads from a user's folder it reads AS that user: a link planted where a file was shows root's secret to nobody", async () => {
    const mal = await ensureUser(29204, homes);
    const secret = path.join(root, "roots-secret.txt");
    fs.writeFileSync(secret, "xoxb-roots-own", { mode: 0o600 });
    await as(mal, `ln -s ${secret} ${mal.home}/rollout.jsonl && echo mine > ${mal.home}/real.jsonl`);
    expect(await readAsUser(mal, path.join(mal.home, "rollout.jsonl"), 10_000)).toBeNull();
    expect((await readAsUser(mal, path.join(mal.home, "real.jsonl"), 10_000))?.trim()).toBe("mine");
  });

  it("TURNUSER-ROOT-STAYS-OUT what the worker deletes in a user's folder it deletes AS that user: a folder swapped for a link to someone else's leads nowhere", async () => {
    const mal = await ensureUser(29205, homes);
    const victim = path.join(root, "victims-codex");
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(path.join(victim, "auth.json"), "the victim's login", { mode: 0o600 });
    await as(mal, `mkdir -p ${mal.home}/agents/echo && ln -s ${victim} ${mal.home}/agents/echo/codex`);
    await removeAsUser(mal, [path.join(mal.home, "agents", "echo", "codex", "auth.json")]);
    expect(fs.readFileSync(path.join(victim, "auth.json"), "utf8")).toBe("the victim's login");
  });

  it("TURNUSER-MOVE-ONCE-SAFELY the copy a login is brought home from is one its user can read and cannot change", async () => {
    const u = await ensureUser(29206, homes);
    const staging = path.join(root, "staging-x");
    fs.mkdirSync(path.join(staging, "login", "sessions"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(staging, "login", "auth.json"), '{"tokens":{"access_token":"t-access-token"}}', { mode: 0o600 });
    await shareForCopy(u, path.join(staging, "login"));
    fs.chmodSync(staging, 0o711);
    expect(await as(u, `cat ${staging}/login/auth.json`)).toContain("access_token");
    await as(u, `echo x >> ${staging}/login/auth.json; rm -f ${staging}/login/auth.json; ln -s /etc ${staging}/login/planted; echo done`);
    expect(fs.readFileSync(path.join(staging, "login", "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"t-access-token"}}');
    expect(fs.existsSync(path.join(staging, "login", "planted"))).toBe(false);
    expect(fs.lstatSync(path.join(staging, "login", "auth.json")).uid).toBe(0);
  });

  it("TURNUSER-DIES-WITH-THE-TURN stopping one user's processes cannot touch another's: it is done as that user, who may signal only its own", async () => {
    const a = await ensureUser(29207, homes);
    const b = await ensureUser(29208, homes);
    await as(b, "setsid sh -c 'sleep 300' >/dev/null 2>&1 & sleep 0.3");
    const aliveAs = (uid: number) => fs.readdirSync("/proc").filter((p) => { try { return /^[0-9]+$/.test(p) && fs.statSync(`/proc/${p}`).uid === uid && fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; } catch { return false; } }).length;
    expect(aliveAs(29208)).toBeGreaterThanOrEqual(1);
    await sweepUser(a);
    expect(aliveAs(29208)).toBeGreaterThanOrEqual(1);
    await sweepUser(b);
    expect(aliveAs(29208)).toBe(0);
  });

  it("TURNUSER-ROOT-STAYS-OUT a folder is handed over only if it holds plain files and folders the worker made: a pipe, or a file with another name elsewhere, is refused", async () => {
    const u = await ensureUser(29209, homes);
    const withPipe = fs.mkdtempSync(path.join(root, "turn-"));
    require("node:child_process").execFileSync("mkfifo", [path.join(withPipe, "pipe")]);
    await expect(giveFresh(u, withPipe)).rejects.toThrow(/plain files/);
    const withLink = fs.mkdtempSync(path.join(root, "turn-"));
    const elsewhere = path.join(root, "roots-file");
    fs.writeFileSync(elsewhere, "root's", { mode: 0o600 });
    fs.linkSync(elsewhere, path.join(withLink, "alias"));
    await expect(giveFresh(u, withLink)).rejects.toThrow(/another name/);
    expect(fs.lstatSync(elsewhere).uid).toBe(0);
  });

  it("TURNUSER-DOORS-TRIED-AT-START what a turn runs is checked all the way down: one writable file deep inside is a door", async () => {
    const src = path.join(root, "source");
    fs.mkdirSync(path.join(src, "deep", "er"), { recursive: true });
    for (const d of [src, path.join(src, "deep"), path.join(src, "deep", "er")]) fs.chmodSync(d, 0o755);
    fs.writeFileSync(path.join(src, "deep", "er", "index.js"), "x");
    fs.chmodSync(path.join(src, "deep", "er", "index.js"), 0o666);
    expect(await openToOthers([], [src])).toEqual([src]);
    fs.chmodSync(path.join(src, "deep", "er", "index.js"), 0o644);
    expect(await openToOthers([], [src])).toEqual([]);
  });

  it("TURNUSER-DOORS-TRIED-AT-START the plain user the doors are tried as is nobody the Cloud could ever allot", () => {
    expect(PROBE_UID).toBeLessThan(20000);
    expect(PROBE_UID).toBeGreaterThan(1000);
  });
});

