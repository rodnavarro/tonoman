// W2 — the codex device-auth login, end to end over the runtime's own HTTP endpoints.
//
// The flow runs the OPPOSITE way round from Claude's: codex prints a URL and a one-time code, the
// person enters OUR code on OpenAI's page, and the CLI polls until the exchange lands. Nothing comes
// back through us, so there is no `/auth/code` — `/auth/login` answers with both strings and
// `/auth/pending` is asked until it says done.
//
// The judgement `/auth/pending` makes is the same one `/auth/code` makes and for the same reason:
// OUTCOME-TRUE. The credential must actually have been written SINCE this login started, and the
// harness must agree. `codex login status` reading a pre-existing auth.json would otherwise bless a
// login nobody ever completed — which, with "Not logged in" also matching a naive check, is two
// different ways to report a fiction.

import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { serveRuntime } from "./server";
import { httpAuthOps } from "../authflow";

let server: Server | undefined;
const tmps: string[] = [];
afterEach(async () => {
  server?.close();
  server = undefined;
  for (const t of tmps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

const TOKEN = "t0k3n";

/** The bytes codex 0.154 actually prints, as a fake login that writes them and then waits — the
 *  shape that matters: the child STAYS ALIVE while the person is on the provider's page. */
const DEVICE_OUTPUT = [
  "Welcome to Codex [v0.154.0]",
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   https://auth.openai.com/codex/device",
  "",
  "2. Enter this one-time code (expires in 15 minutes)",
  "   JLEP-DT273",
  "",
].join("\n");

async function scratch(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "deviceauth-"));
  tmps.push(d);
  return d;
}

/** Boot a runtime whose "login" writes the device transcript to the auth log and then sleeps, and
 *  whose "status" reads a file the test controls. No PTY: device auth prints to a plain pipe. */
async function bootDevice(o: { dir: string; statusFile: string; credFile: string }): Promise<number> {
  const login = path.join(o.dir, "login.js");
  await fs.writeFile(
    login,
    `const fs=require("fs");fs.writeFileSync(process.argv[2], ${JSON.stringify(DEVICE_OUTPUT)});setInterval(()=>{},1000);`,
  );
  const status = path.join(o.dir, "status.js");
  await fs.writeFile(
    status,
    `const fs=require("fs");process.stdout.write(fs.existsSync(${JSON.stringify(o.statusFile)})?fs.readFileSync(${JSON.stringify(o.statusFile)},"utf8"):"Not logged in");`,
  );
  const authLog = path.join(o.dir, "auth.log");
  server = serveRuntime({
    port: 0,
    token: TOKEN,
    authLog,
    credFile: o.credFile,
    // The runtime takes its login argv from the harness SPEC, never from the wire; injected here so
    // the test drives a fake login instead of a real OAuth flow.
    loginArgs: [process.execPath, login, authLog],
    statusArgs: [process.execPath, status],
    // No `script`: this exercises the same plumbing without needing util-linux on the test host.
    ptyArgv: (cmd) => cmd.split(" "),
  });
  await new Promise((r) => server!.on("listening", r));
  return (server!.address() as AddressInfo).port;
}

describe("POST /auth/login?harness=codex — a URL AND a code (W2)", () => {
  it("answers with both strings and keeps the login alive (no /auth/code step)", async () => {
    const dir = await scratch();
    const port = await bootDevice({ dir, statusFile: path.join(dir, "st"), credFile: path.join(dir, "auth.json") });
    const ops = httpAuthOps(`http://127.0.0.1:${port}`, TOKEN, undefined, undefined, "codex");
    expect(await ops.startHeadless()).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "JLEP-DT273",
    });
  });
});

describe("GET /auth/pending — OUTCOME-TRUE, polled (W2)", () => {
  it("is not done while the person is still on the provider's page", async () => {
    const dir = await scratch();
    const port = await bootDevice({ dir, statusFile: path.join(dir, "st"), credFile: path.join(dir, "auth.json") });
    const ops = httpAuthOps(`http://127.0.0.1:${port}`, TOKEN, undefined, undefined, "codex");
    await ops.startHeadless();
    expect(await ops.pending!()).toMatchObject({ done: false, loggedIn: false });
  });

  it("is done once the credential lands AND the CLI agrees", async () => {
    const dir = await scratch();
    const statusFile = path.join(dir, "st");
    const credFile = path.join(dir, "auth.json");
    const port = await bootDevice({ dir, statusFile, credFile });
    const ops = httpAuthOps(`http://127.0.0.1:${port}`, TOKEN, undefined, undefined, "codex");
    await ops.startHeadless();
    await fs.writeFile(credFile, '{"tokens":{"access_token":"x"}}');
    await fs.writeFile(statusFile, "Logged in using ChatGPT");
    const r = await ops.pending!();
    expect(r.done).toBe(true);
    expect(r.status).toBe("Logged in using ChatGPT");
  });

  it("a PRE-EXISTING credential is not a login: status alone never makes it done", async () => {
    // The whole reason the baseline is snapshotted at /auth/login. Without it, an agent that was
    // signed in yesterday would report every abandoned login as a success.
    const dir = await scratch();
    const statusFile = path.join(dir, "st");
    const credFile = path.join(dir, "auth.json");
    await fs.writeFile(credFile, '{"tokens":{"access_token":"stale"}}');
    await fs.writeFile(statusFile, "Logged in using ChatGPT");
    const port = await bootDevice({ dir, statusFile, credFile });
    const ops = httpAuthOps(`http://127.0.0.1:${port}`, TOKEN, undefined, undefined, "codex");
    await ops.startHeadless();
    const r = await ops.pending!();
    expect(r.loggedIn).toBe(true); // status alone WOULD have said yes...
    expect(r.done).toBe(false); // ...but the credential has not moved since this login began
  });

  it("is bearer-gated like everything else here", async () => {
    const dir = await scratch();
    const port = await bootDevice({ dir, statusFile: path.join(dir, "st"), credFile: path.join(dir, "auth.json") });
    const res = await fetch(`http://127.0.0.1:${port}/auth/pending?harness=codex`);
    expect(res.status).toBe(401);
  });
});
