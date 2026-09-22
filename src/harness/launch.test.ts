// Starting a program as a turn's own Linux user (docs/definition/objects/turn-user.md in Tonoman
// Cloud). The pure half runs anywhere; the half that really drops privileges needs Linux and root,
// and runs in the dev worker container:
//
//   podman exec tonoman-dev-worker sh -c 'cd /opt/tonoman/live && npx vitest run src/harness/launch.test.ts'
import { describe, it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { launchArgs, homeOf, homeIn, passwdLine, groupLine, ensureUser, asUser, canDrop, commandFor, openToOthers, ownGroup, stopAll } from "./launch";

const ana = { uid: 20001, home: "/srv/tonoman/homes/20001" };

describe("the launcher's words (pure)", () => {
  it("TURNUSER-ONE-LAUNCHER a program is started as the user and its own group, with no other groups, and cannot get privileges back", () => {
    const { cmd, args } = launchArgs(ana, "codex", ["exec", "--json"]);
    expect(cmd).toBe("setpriv");
    const flags = args.slice(0, args.indexOf("--"));
    expect(flags).toEqual(expect.arrayContaining(["--reuid=20001", "--regid=20001", "--clear-groups", "--no-new-privs", "--inh-caps=-all"]));
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["codex", "exec", "--json"]);
  });

  it("TURNUSER-ONE-LAUNCHER root, or a number that is not a turn user's, is never launched as", () => {
    for (const uid of [0, 1, 999, 19999, -1, 1.5, Number.NaN]) expect(() => launchArgs({ uid, home: "/x" }, "codex", [])).toThrow(/not a turn user/);
  });

  it("TURNUSER-HOME-PRIVATE a user's home is its number, outside the worker's own folders; what it keeps for one agent sits inside", () => {
    expect(homeOf(20001, "/srv/tonoman/homes")).toBe("/srv/tonoman/homes/20001");
    expect(homeIn(ana, "g-echo", "claude")).toBe("/srv/tonoman/homes/20001/agents/g-echo/claude");
    expect(homeIn(ana, "g-echo", "codex")).toBe("/srv/tonoman/homes/20001/agents/g-echo/codex");
    // An agent's name arrives over the wire: it cannot climb out of the home.
    expect(homeIn(ana, "../../etc", "claude")).toBe("/srv/tonoman/homes/20001/agents/etc/claude");
    expect(homeIn(ana, "", "claude")).toBe("/srv/tonoman/homes/20001/agents/_invalid/claude");
  });

  it("TURNUSER-ONE-LAUNCHER the user exists by name too, for programs that look themselves up, with no password and no shell", () => {
    expect(passwdLine(ana)).toBe("tu20001:x:20001:20001:Tonoman turn user:/srv/tonoman/homes/20001:/usr/sbin/nologin");
    expect(groupLine(ana)).toBe("tu20001:x:20001:");
  });
});

describe("the command a harness starts (pure)", () => {
  it("TURNUSER-NOTHING-AS-ROOT with a user to run as, the program is started through the launcher, at home in that user's home", () => {
    // Where its login is, is handed over for THIS run — not found in the worker's environment.
    const c = commandFor(ana, "claude", ["-p"], { PATH: "/usr/bin" }, { CLAUDE_CONFIG_DIR: "/srv/tonoman/homes/20001/agents/echo/claude" });
    expect(c.cmd).toBe("setpriv");
    expect(c.args.slice(-2)).toEqual(["claude", "-p"]);
    expect(c.env).toMatchObject({ HOME: "/srv/tonoman/homes/20001", TMPDIR: "/srv/tonoman/homes/20001/tmp", USER: "tu20001", CLAUDE_CONFIG_DIR: "/srv/tonoman/homes/20001/agents/echo/claude" });
  });

  it("TURNUSER-NOTHING-AS-ROOT a self-hosted agent, which has no user to run as, is started exactly as before", () => {
    const env = { PATH: "/usr/bin" };
    expect(commandFor(undefined, "claude", ["-p"], env)).toEqual({ cmd: "claude", args: ["-p"], env });
  });
});

// The real thing: Linux, as root, with setpriv. Anywhere else these are skipped, and say so.
describe.skipIf(!canDrop())("really dropping to a user (Linux, root)", () => {
  fs.mkdirSync("/srv", { recursive: true });
  const root = fs.mkdtempSync("/srv/tonoman-launch-test-");
  fs.chmodSync(root, 0o711); // passable, not listable — as the real folder of homes is
  const homes = path.join(root, "homes");
  const mk = (uid: number) => ensureUser(uid, homes);
  const run = (user: { uid: number; home: string }, script: string): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const { cmd, args } = launchArgs(user, "sh", ["-c", script]);
      const c = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: user.home } });
      let out = "";
      c.stdout.on("data", (b) => (out += b));
      c.stderr.on("data", (b) => (out += b));
      c.on("close", (code) => resolve({ code, out }));
    });

  it("TURNUSER-ONE-LAUNCHER the program runs as the user: its number, its one group, no way back to privileges, no capabilities", async () => {
    const u = await mk(29001);
    const r = await run(u, "id -u; id -g; id -G; grep -E '^(NoNewPrivs|CapEff|CapBnd|CapInh)' /proc/self/status");
    expect(r.out).toMatch(/^29001\n29001\n29001\n/);
    expect(r.out).toMatch(/NoNewPrivs:\s+1/);
    expect(r.out).toMatch(/CapEff:\s+0+\n/);
    expect(r.out).toMatch(/CapInh:\s+0+\n/);
  });

  it("TURNUSER-ONE-LAUNCHER asUser checks that the drop held before it hands a user back, and says why when it did not", async () => {
    const u = await asUser(29002, homes);
    expect(u).toMatchObject({ uid: 29002, home: path.join(homes, "29002") });
  });

  it("TURNUSER-HOME-PRIVATE the home is the user's alone: another user cannot list it, read it, or write into it", async () => {
    const a = await mk(29003);
    const b = await mk(29004);
    fs.writeFileSync(path.join(a.home, "login.json"), "ana's login");
    fs.chownSync(path.join(a.home, "login.json"), a.uid, a.uid);
    expect((await run(a, `cat ${a.home}/login.json`)).out).toContain("ana's login");
    const r = await run(b, `ls ${a.home}; cat ${a.home}/login.json; echo x > ${a.home}/planted; echo done`);
    expect(r.out).not.toContain("ana's login");
    expect(r.out).toMatch(/Permission denied/);
    expect(fs.existsSync(path.join(a.home, "planted"))).toBe(false);
    // Nor can it see who else has a home here.
    expect((await run(b, `ls ${homes}`)).out).toMatch(/Permission denied/);
  });

  it("TURNUSER-CANNOT-REACH what is root's stays root's: a secret file, the worker's state, a write outside the home", async () => {
    const u = await mk(29005);
    const secret = path.join(root, "secrets");
    fs.mkdirSync(secret, { mode: 0o700 });
    fs.writeFileSync(path.join(secret, "slack-bot-token"), "xoxb-not-for-you", { mode: 0o600 });
    const r = await run(u, `cat ${secret}/slack-bot-token; ls /root; echo planted > ${root}/planted; echo planted > /etc/planted; echo done`);
    expect(r.out).not.toContain("xoxb-not-for-you");
    expect(fs.existsSync(path.join(root, "planted"))).toBe(false);
    expect(fs.existsSync("/etc/planted")).toBe(false);
    expect((await run(u, `echo mine > ${u.home}/note && cat ${u.home}/note`)).out).toContain("mine");
  });

  it("TURNUSER-CANNOT-REACH it cannot read the worker's own environment, where the platform's tokens are", async () => {
    const u = await mk(29006);
    const r = await run(u, `cat /proc/${process.pid}/environ | tr '\\0' '\\n' | head -3; echo done`);
    expect(r.out).toMatch(/Permission denied/);
  });

  it("TURNUSER-ONE-LAUNCHER a program that would give privileges back does not: su and a setuid file are no way out", async () => {
    const u = await mk(29007);
    const r = await run(u, "su -s /bin/sh -c 'id -u' root </dev/null 2>&1; echo after:$(id -u)");
    expect(r.out).toContain("after:29007");
    expect(r.out).not.toMatch(/^0$/m);
  });

  it("TURNUSER-CANNOT-REACH the worker can tell, before it serves anyone, which of the places it must keep closed a plain user can in fact open", async () => {
    const closed = path.join(root, "closed-secrets");
    fs.mkdirSync(closed, { mode: 0o700 });
    fs.writeFileSync(path.join(closed, "token"), "x", { mode: 0o600 });
    // What a Windows folder mounted into a container looks like: open to everyone, whatever was meant.
    const open = path.join(root, "open-secrets");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    fs.writeFileSync(path.join(open, "token"), "x");
    fs.chmodSync(path.join(open, "token"), 0o666);
    // The same open folder, behind a door only root can pass: not reachable, so not open.
    const behind = path.join(closed, "mounted-here");
    fs.mkdirSync(behind);
    fs.chmodSync(behind, 0o777);
    expect(await openToOthers([closed, open, behind, path.join(root, "not-there")])).toEqual([open]);
  });

  it("TURNUSER-DIES-WITH-THE-TURN when a turn is stopped, what it left running in the background stops too: nothing stays behind under that user", async () => {
    const u = await mk(29009);
    // Alive, not merely listed: a process that has ended stays in /proc until something reaps it.
    const running = () =>
      fs.readdirSync("/proc").filter((p) => {
        if (!/^[0-9]+$/.test(p)) return false;
        try {
          return fs.statSync(`/proc/${p}`).uid === 29009 && fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
        } catch {
          return false;
        }
      }).length;
    const { cmd, args } = launchArgs(u, "sh", ["-c", "sleep 300 & sleep 300 & wait"]);
    const c = spawn(cmd, args, { env: { PATH: process.env.PATH }, stdio: "ignore", ...ownGroup(u) });
    await new Promise((r) => setTimeout(r, 500));
    expect(running()).toBeGreaterThanOrEqual(3);
    stopAll(c, true);
    await new Promise((r) => setTimeout(r, 500));
    expect(running()).toBe(0);
  });

  it("TURNUSER-ONE-LAUNCHER making the same user twice changes nothing, and its name resolves", async () => {
    const first = await mk(29008);
    const again = await mk(29008);
    expect(again).toEqual(first);
    expect(execFileSync("getent", ["passwd", "29008"]).toString()).toContain("tu29008");
    expect(execFileSync("sh", ["-c", "grep -c '^tu29008:' /etc/passwd"]).toString().trim()).toBe("1");
  });
});
