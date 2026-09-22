// Asking the Cloud whose user a run goes out as, and handing that user what the worker made for it
// (docs/definition/objects/turn-user.md in Tonoman Cloud). The half that changes ownership needs
// Linux and root and runs in the dev worker container; see launch.test.ts for how.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { canDrop } from "./launch";
import { turnUsers, copyLogin } from "./turnusers";

describe("asking the Cloud (pure, with a fake Cloud)", () => {
  const cloud = (answers: Record<string, { uid: number; of: string } | number>) => {
    const asked: string[] = [];
    const f = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const who = (JSON.parse(init.body) as { slackUserId?: string }).slackUserId ?? "-";
      asked.push(`${new URL(url).pathname} ${who} ${init.headers.authorization}`);
      const a = answers[who];
      return typeof a === "number" ? { ok: false, status: a, json: async () => ({}) } : { ok: true, status: 200, json: async () => a };
    }) as never;
    return { f, asked };
  };
  const made: number[] = [];
  const make = async (uid: number) => (made.push(uid), { uid, home: `/srv/tonoman/homes/${uid}` });

  it("TURNUSER-NUMBER-FROM-CLOUD the worker asks by agent and who is speaking, with its system token, and makes the user it is told", async () => {
    const c = cloud({ UANA: { uid: 20002, of: "person" }, "-": { uid: 20001, of: "agent" } });
    const u = turnUsers({ api: "http://cloud", token: "sys", fetch: c.f, make });
    expect(await u.for("g-sapien", "UANA")).toEqual({ uid: 20002, home: "/srv/tonoman/homes/20002", of: "person" });
    expect(await u.for("g-sapien", undefined)).toEqual({ uid: 20001, home: "/srv/tonoman/homes/20001", of: "agent" });
    expect(c.asked).toEqual(["/v1/system/agents/g-sapien/turn-user UANA Bearer sys", "/v1/system/agents/g-sapien/turn-user - Bearer sys"]);
  });

  it("TURNUSER-NOTHING-AS-ROOT a Cloud that does not answer, or answers with a number that is not a turn user's, stops the run", async () => {
    const down = turnUsers({ api: "http://cloud", token: "sys", fetch: cloud({ UANA: 503 }).f, make });
    await expect(down.for("g-sapien", "UANA")).rejects.toThrow(/503/);
    const root = turnUsers({ api: "http://cloud", token: "sys", fetch: cloud({ UANA: { uid: 0, of: "person" } }).f, make });
    await expect(root.for("g-sapien", "UANA")).rejects.toThrow(/not a turn user/);
  });

  it("TURNUSER-WHOSE it asks every time: someone who has left the tenant stops running as themselves on their very next message", async () => {
    const answers: Record<string, { uid: number; of: string }> = { UANA: { uid: 20002, of: "person" } };
    const c = cloud(answers);
    const u = turnUsers({ api: "http://cloud", token: "sys", fetch: c.f, make });
    expect((await u.for("g-sapien", "UANA")).of).toBe("person");
    answers.UANA = { uid: 20001, of: "agent" }; // removed from the tenant
    expect(await u.for("g-sapien", "UANA")).toMatchObject({ uid: 20001, of: "agent" });
    expect(c.asked).toHaveLength(2);
  });
});

describe.skipIf(!canDrop())("handing over (Linux, root)", () => {
  fs.mkdirSync("/srv", { recursive: true });
  const root = fs.mkdtempSync("/srv/tonoman-handover-test-");
  fs.chmodSync(root, 0o711);
  const user = (uid: number) => {
    const home = path.join(root, "homes", String(uid));
    fs.mkdirSync(home, { recursive: true });
    fs.chownSync(home, uid, uid);
    return { uid, home };
  };
  const u = turnUsers({ api: "http://unused", token: "x", make: async (uid) => user(uid) });
  const owner = (p: string) => fs.lstatSync(p).uid;

  it("TURNUSER-TOOLS-REACHABLE the turn's folder, what is in it, and its prompt file become the user's and nobody else's", async () => {
    const ana = user(29101);
    const cwd = fs.mkdtempSync(path.join(root, "turn-"));
    fs.writeFileSync(path.join(cwd, "receipt.jpg"), "photo");
    const prompt = path.join(cwd, ".tonoman-system.md"); // the worker puts it in the turn's own folder
    fs.writeFileSync(prompt, "identity");
    const configHome = path.join(ana.home, "agents", "echo", "codex");
    await u.handOver(ana, { cwd, configHome });
    for (const p of [cwd, path.join(cwd, "receipt.jpg"), prompt, configHome, path.join(ana.home, "tmp")]) expect(owner(p)).toBe(29101);
    expect(fs.lstatSync(cwd).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(prompt).mode & 0o777).toBe(0o600);
    // Run again on a fresh session, the same folder comes back: already the user's, and left alone —
    // because the worker REMEMBERS handing it over, not because it looks at the folder to find out.
    await u.handOver(ana, { cwd, cwdIsUsers: true, configHome });
    // Not told so, it does not quietly walk a user's folder as root: it refuses.
    await expect(u.handOver(ana, { cwd, configHome })).rejects.toThrow(/already handed over/);
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a login kept where logins used to live is brought into the user's home once, owned by it; the old one is set aside, not deleted", async () => {
    const ben = user(29102);
    const old = path.join(root, "old-logins", "echo", "users", "UBEN");
    fs.mkdirSync(path.join(old, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"bens-access-token"}}');
    fs.writeFileSync(path.join(old, "sessions", "rollout-1.jsonl"), "{}\n");
    const configHome = path.join(ben.home, "agents", "echo", "codex");
    await u.handOver(ben, { configHome, oldConfigHome: old, credName: "auth.json" });
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"bens-access-token"}}');
    expect(owner(path.join(configHome, "auth.json"))).toBe(29102);
    expect(owner(path.join(configHome, "sessions", "rollout-1.jsonl"))).toBe(29102);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readdirSync(path.dirname(old)).some((n) => n.startsWith("UBEN.moved-"))).toBe(true);
    // A second turn finds it already home and moves nothing.
    fs.writeFileSync(path.join(configHome, "auth.json"), '{"tokens":{"access_token":"refreshed-access-token"}}');
    await u.handOver(ben, { configHome, oldConfigHome: old, credName: "auth.json" });
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"refreshed-access-token"}}');
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a home that a status check already wrote its own files into, but that holds no login, still gets the login (found live)", async () => {
    const eve = user(29105);
    const old = path.join(root, "old-logins", "echo", "users", "UEVE");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"eves-access-token"}}');
    const configHome = path.join(eve.home, "agents", "echo", "codex");
    fs.mkdirSync(configHome, { recursive: true });
    fs.writeFileSync(path.join(configHome, "state_5.sqlite"), "what `codex login status` leaves behind");
    // Left by the provider running AS the user, so the user's own — every level of it.
    for (const p of [path.join(eve.home, "agents"), path.join(eve.home, "agents", "echo"), configHome, path.join(configHome, "state_5.sqlite")]) fs.chownSync(p, 29105, 29105);
    await u.handOver(eve, { configHome, oldConfigHome: old, credName: "auth.json" });
    expect(fs.readFileSync(path.join(configHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"eves-access-token"}}');
    expect(owner(path.join(configHome, "auth.json"))).toBe(29105);
  });

  it("TURNUSER-MOVE-ONCE-SAFELY a link in the old login is not followed: what it points at is never copied into anyone's home", async () => {
    const cy = user(29103);
    const secret = path.join(root, "a-secret");
    fs.writeFileSync(secret, "xoxb-not-for-anyone", { mode: 0o600 });
    const old = path.join(root, "old-logins", "echo", "users", "UCY");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "auth.json"), '{"tokens":{"access_token":"cys-access-token"}}');
    fs.symlinkSync(secret, path.join(old, "innocent.json"));
    const configHome = path.join(cy.home, "agents", "echo", "codex");
    await u.handOver(cy, { configHome, oldConfigHome: old, credName: "auth.json" });
    expect(fs.existsSync(path.join(configHome, "innocent.json"))).toBe(false);
    expect(fs.existsSync(path.join(configHome, "auth.json"))).toBe(true);
  });

  it("TURNUSER-TOOLS-REACHABLE a folder that is not the user's to be given — somewhere else on the machine, or a link — is refused", async () => {
    const dee = user(29104);
    const configHome = path.join(dee.home, "agents", "echo", "codex");
    const link = path.join(root, "turn-link");
    fs.symlinkSync("/etc", link);
    await expect(u.handOver(dee, { cwd: link, configHome })).rejects.toThrow(/only a folder the worker made/);
    await expect(u.handOver(dee, { configHome: "/etc/elsewhere" })).rejects.toThrow(/inside its home/);
    expect(owner("/etc")).toBe(0);
  });
});

describe("copying a login (pure enough to run anywhere)", () => {
  it("TURNUSER-MOVE-ONCE-SAFELY files and folders are copied; links, devices and anything else are left behind", async () => {
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copylogin-"));
    const from = path.join(tmp, "from");
    fs.mkdirSync(path.join(from, "deep", "er"), { recursive: true });
    fs.writeFileSync(path.join(from, "auth.json"), "a");
    fs.writeFileSync(path.join(from, "deep", "er", "x.jsonl"), "b");
    const copied = await copyLogin(from, path.join(tmp, "to"));
    expect(copied).toBe(2);
    expect(fs.readFileSync(path.join(tmp, "to", "deep", "er", "x.jsonl"), "utf8")).toBe("b");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
