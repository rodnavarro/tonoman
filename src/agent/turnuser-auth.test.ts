// Signing in, signing out and checking a login all start the provider's own program — so they run as
// the turn's user too, in that user's home, never as the service itself (TURNUSER-NOTHING-AS-ROOT in
// Tonoman Cloud's docs/definition/objects/turn-user.md). The launcher is injected: really dropping
// privileges is proven in src/harness/launch.test.ts, as root in the dev worker.
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { serveRuntime } from "./server";
import { httpAuthOps } from "../authflow";
import { childEnv } from "../harness/turnenv";

let server: Server | undefined;
const tmps: string[] = [];
afterEach(async () => {
  server?.close();
  server = undefined;
  delete process.env.TONOMANCLOUD_API_TOKEN;
  delete process.env.TONOMAN_TURN_USERS;
  for (const t of tmps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

const TOKEN = "t0k3n";
const DEVICE_OUTPUT = "Open this link\n   https://auth.openai.com/codex/device\nEnter this one-time code\n   JLEP-DT273\n";

async function boot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tu-auth-"));
  tmps.push(dir);
  const homes = path.join(dir, "homes");
  const envDump = path.join(dir, "login-env.json");
  const login = path.join(dir, "login.js");
  await fs.writeFile(login, `const fs=require("fs");fs.writeFileSync(process.argv[2], ${JSON.stringify(DEVICE_OUTPUT)});fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));setInterval(()=>{},1000);`);
  const status = path.join(dir, "status.js");
  await fs.writeFile(status, `process.stdout.write("Logged in as " + (process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR || "nobody"));`);
  const authLog = path.join(dir, "auth.log");
  const launched: { uid: number; bin: string; env: NodeJS.ProcessEnv }[] = [];
  process.env.TONOMANCLOUD_API_TOKEN = "sys-secret-not-for-a-login";
  server = serveRuntime({
    port: 0,
    token: TOKEN,
    authLog,
    loginArgs: [process.execPath, login, authLog],
    statusArgs: [process.execPath, status],
    ptyArgv: (cmd) => cmd.split(" "),
    turnUsers: {
      make: async (uid) => {
        if (uid < 20000) throw new Error(`${uid} is not a turn user's number`);
        const home = path.join(homes, String(uid));
        await fs.mkdir(home, { recursive: true });
        return { uid, home };
      },
      own: async (_u, folders) => void (await Promise.all(folders.map((f) => fs.mkdir(f, { recursive: true })))),
      // The real launcher's environment, without the part that needs root: what is on the list, plus
      // what this run adds.
      command: (runAs, bin, args, env, extra = {}) => {
        const made = runAs ? { ...childEnv(env, extra), HOME: runAs.home } : { ...env, ...extra };
        if (runAs) launched.push({ uid: runAs.uid, bin, env: made });
        return { cmd: bin, args, env: made };
      },
    },
  });
  await new Promise((r) => server!.on("listening", r));
  const port = (server!.address() as AddressInfo).port;
  const call = (p: string, method = "GET") => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  return { call, launched, homes, envDump, port };
}

describe("signing in as the turn's user", () => {
  it("TURNUSER-NOTHING-AS-ROOT a sign-in is started as the user it is for, with its login in that user's home and none of the service's own tokens", async () => {
    const r = await boot();
    const res = await r.call("/auth/login?agent=echo&user=UANA&harness=codex&uid=20002", "POST");
    expect(res.status).toBe(200);
    expect(r.launched).toHaveLength(1);
    expect(r.launched[0]!.uid).toBe(20002);
    const home = path.join(r.homes, "20002", "agents", "echo", "codex").replace(/\\/g, "/");
    expect(String(r.launched[0]!.env.CODEX_HOME).replace(/\\/g, "/")).toBe(home);
    // What the login program itself saw.
    for (let i = 0; i < 50 && !(await fs.stat(r.envDump).catch(() => null)); i++) await new Promise((x) => setTimeout(x, 50));
    const seen = JSON.parse(await fs.readFile(r.envDump, "utf8")) as Record<string, string>;
    expect(JSON.stringify(seen)).not.toContain("sys-secret-not-for-a-login");
    expect(String(seen.CODEX_HOME).replace(/\\/g, "/")).toBe(home);
  });

  it("TURNUSER-NOTHING-AS-ROOT checking a login runs as that user too, against the same home", async () => {
    const r = await boot();
    const res = await r.call("/auth/status?agent=echo&user=UANA&harness=codex&uid=20002");
    const body = (await res.json()) as { status: string };
    expect(r.launched.map((l) => l.uid)).toEqual([20002]);
    expect(body.status.replace(/\\/g, "/")).toContain("/20002/agents/echo/codex");
  });

  it("TURNUSER-ONE-LAUNCHER a number that is not a turn user's starts nothing", async () => {
    const r = await boot();
    const res = await r.call("/auth/login?agent=echo&user=UANA&harness=codex&uid=0", "POST");
    expect(res.status).toBe(400);
    expect(r.launched).toEqual([]);
  });

  it("TURNUSER-NOTHING-AS-ROOT a self-hosted service, asked with no user number, signs in exactly as before", async () => {
    const r = await boot();
    expect((await r.call("/auth/login?agent=echo&harness=codex", "POST")).status).toBe(200);
    expect(r.launched).toEqual([]);
  });

  it("TURNUSER-NOTHING-AS-ROOT where turns run as their own users, this service runs no turns: one started here would run as root, beside every home", async () => {
    const r = await boot();
    process.env.TONOMAN_TURN_USERS = "on";
    const res = await fetch(`http://127.0.0.1:${r.port}/turn`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "hi" }) });
    expect(res.status).toBe(403);
    expect(r.launched).toEqual([]);
  });

  it("TURNUSER-NOTHING-AS-ROOT it starts programs as any user it is asked to, so where turns run as their own users it does not start without a token", () => {
    process.env.TONOMAN_TURN_USERS = "on";
    expect(() => serveRuntime({ port: 0 })).toThrow(/token/i);
    expect(() => serveRuntime({ port: 0, token: "  " })).toThrow(/token/i);
  });

  it("TURNUSER-NOTHING-AS-ROOT asked for someone's usage without saying whose user it is, it reads nobody's login", async () => {
    const r = await boot();
    process.env.TONOMAN_TURN_USERS = "on";
    const res = await r.call("/usage?agent=echo&harness=codex");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ windows: [] });
  });

  it("TURNUSER-WHOSE the worker says whose user it is as well as its number, so the service brings home the same old login the worker would", async () => {
    const r = await boot();
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((u: string, init?: RequestInit) => (seen.push(String(u)), real(u, init))) as typeof fetch;
    try {
      await httpAuthOps(`http://127.0.0.1:${r.port}`, TOKEN, "echo", "UANA", "codex", async () => ({ uid: 20002, of: "agent" as const })).status();
    } finally {
      globalThis.fetch = real;
    }
    expect(seen[0]).toMatch(/[?&]uid=20002&of=agent$/);
  });

  it("TURNUSER-NUMBER-FROM-CLOUD the worker tells the service which user it is on every call", async () => {
    const r = await boot();
    const ops = httpAuthOps(`http://127.0.0.1:${r.port}`, TOKEN, "echo", "UANA", "codex", async () => 20002);
    await ops.status();
    expect(r.launched.map((l) => l.uid)).toEqual([20002]);
  });
});
