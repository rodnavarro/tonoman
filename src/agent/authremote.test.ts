// roster-auth-remote — the headless login across the k8s split. The gateway can't `podman exec`
// into a remote agent, so the AGENT runs its own login over /auth/login + /auth/code, and the CLI
// drives it through httpAuthOps. These tests stand up the REAL runtime server against a FAKE login
// binary (a tiny shell script that prints an OAuth URL, reads a code, and writes a credential file
// exactly like `claude auth login` would) — so the PTY/stdin plumbing is exercised for real, with
// no OAuth and no tokens spent.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { serveRuntime } from "./server";
import { httpAuthOps, transportFailure } from "../authflow";

const TOKEN = "test-token";
const URL_IN_LOGIN = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
const GOOD_CODE = "the-right-code";

let dir: string;
let server: Server;
let base: string;
let credFile: string;

/** A stand-in for `claude auth login`: prints the URL, waits for a code on stdin, and — only for
 * the right code — writes the credential file and reports success, like the real thing. */
async function writeFakeHarness(): Promise<{ loginArgs: string[]; statusArgs: string[] }> {
  const login = sh(path.join(dir, "fake-login.sh"));
  const status = sh(path.join(dir, "fake-status.sh"));
  await fs.writeFile(
    login,
    `#!/bin/sh
echo "Browser didn't open? Use the url below to sign in"
echo "${URL_IN_LOGIN}"
printf 'Paste code here if prompted > '
read code
if [ "$code" = "${GOOD_CODE}" ]; then
  printf '%s' '{"claudeAiOauth":{"accessToken":"fake"}}' > "${credFile}"
  echo "Login successful."
else
  echo "Invalid code. Please make sure the full code was copied."
fi
`,
    { mode: 0o755 },
  );
  // Logged-in iff the credential exists — mirrors `claude auth status`.
  await fs.writeFile(
    status,
    `#!/bin/sh
if [ -f "${credFile}" ]; then echo '{"loggedIn": true, "email": "agent@example.com"}'; else echo '{"loggedIn": false}'; fi
`,
    { mode: 0o755 },
  );
  return { loginArgs: ["sh", login], statusArgs: ["sh", status] };
}

/** Forward slashes: these paths get embedded in `sh -c` strings, and on Windows a backslash is an
 * escape character there. Node accepts forward slashes on every platform. */
const sh = (p: string): string => p.replace(/\\/g, "/");

beforeAll(async () => {
  dir = sh(await fs.mkdtemp(path.join(os.tmpdir(), "tonoman-authremote-")));
  credFile = sh(path.join(dir, ".credentials.json"));
  const { loginArgs, statusArgs } = await writeFakeHarness();
  server = serveRuntime({
    port: 0,
    token: TOKEN,
    credFile,
    loginArgs,
    statusArgs,
    authLog: sh(path.join(dir, "auth.log")),
    authSettleMs: 400, // the fake login writes its cred instantly — no OAuth round trip to wait on
    // Production runs the login under `script` (a real PTY — the harness login is a TUI). This
    // host has no `script`, so we substitute a plain redirect: same stdin pipe, same transcript
    // file, same outcome check — the PTY itself is covered by the live proof, not by this test.
    ptyArgv: (cmd, log) => ["sh", "-c", `${cmd} > ${log} 2>&1`],
  });
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const ops = (): ReturnType<typeof httpAuthOps> => httpAuthOps(base, TOKEN);

describe("roster-auth-remote — headless login over the agent's own HTTP runtime", () => {
  it("URL out, code in: the operator gets the OAuth URL and the code completes the login", async () => {
    const url = await ops().startHeadless();
    expect(url).toBe(URL_IN_LOGIN);

    // the credential does not exist until the code lands — the login is genuinely pending
    await expect(fs.stat(credFile)).rejects.toThrow();

    const r = await ops().submitCode(GOOD_CODE);
    expect(r.ok).toBe(true);
    expect(r.status).toContain("loggedIn");
    await expect(fs.stat(credFile)).resolves.toBeTruthy(); // creds landed in the AGENT's store
  });

  it("a wrong code is NOT a false ✓ — the credential never changed, so ok stays false", async () => {
    await fs.rm(credFile, { force: true });
    await ops().startHeadless();
    const r = await ops().submitCode("wrong-code");
    expect(r.ok).toBe(false);
    expect(r.loginTail).toContain("Invalid code");
  });

  it("OUTCOME-TRUE, not status-true: a stale credential + a failed login still reports NOT ok", async () => {
    // The trap this guards: `auth status` reads a PRE-EXISTING credential and says "logged in",
    // so a login that never completed would report ✓. Success requires the file to CHANGE.
    await fs.writeFile(credFile, '{"claudeAiOauth":{"accessToken":"stale"}}');
    await ops().startHeadless();
    const r = await ops().submitCode("wrong-code");
    expect(r.status).toContain("loggedIn"); // status alone WOULD have said yes...
    expect(r.ok).toBe(false); // ...but the credential didn't change, so we don't claim success
    await fs.rm(credFile, { force: true });
  });

  it("a code with no login in flight is a clean error, not a hang", async () => {
    await expect(ops().submitCode(GOOD_CODE)).rejects.toThrow(/409|no login in progress/i);
  });

  it("the /auth endpoints are bearer-gated like /turn", async () => {
    await expect(httpAuthOps(base, "wrong-token").startHeadless()).rejects.toThrow(/401|unauthorized/i);
    const res = await fetch(`${base}/auth/status`);
    expect(res.status).toBe(401);
  });

  it("a second login supersedes a pending one (the stale PKCE verifier is dead anyway)", async () => {
    await ops().startHeadless();
    const url = await ops().startHeadless(); // must not hang or 409
    expect(url).toBe(URL_IN_LOGIN);
  });

  // A runtime that is NOT THERE is the failure a person actually meets: the sidecar is down, or
  // the worker is running somewhere the sidecar isn't. It reached Slack as "fetch failed".
  it("names the address and the reason when the runtime cannot be reached", async () => {
    // A real connection attempt to a port nothing is listening on - not a mock, and not one of
    // undici's BLOCKED ports (1, 7, 9, 11 ...), which fail with "bad port" before any connect.
    await expect(httpAuthOps("http://127.0.0.1:49999", TOKEN).startHeadless()).rejects.toThrow(
      /couldn't reach the agent runtime at http:\/\/127\.0\.0\.1:49999 \((ECONNREFUSED|ECONNRESET)\)/,
    );
  });
});

describe("transportFailure", () => {
  it("digs the code out of a bare fetch failure", () => {
    const e = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(transportFailure(e, "http://host:8080")).toBe(
      "couldn't reach the agent runtime at http://host:8080 (ECONNREFUSED)",
    );
  });

  it("digs it out of an AggregateError, whose own code is undefined", () => {
    // Node tries every resolved address - IPv6 first - and reports the set. Reading `cause.code`
    // alone would have produced "(undefined)", which is worse than the message it replaced.
    const agg = Object.assign(new AggregateError([], "all attempts failed"), {
      errors: [Object.assign(new Error("connect ECONNREFUSED ::1:8080"), { code: "ECONNREFUSED" })],
    });
    const e = Object.assign(new TypeError("fetch failed"), { cause: agg });
    expect(transportFailure(e, "http://host:8080")).toMatch(/\(ECONNREFUSED\)$/);
  });

  it("prefers the innermost message over the wrapper's own, when there is no code", () => {
    // undici rejects a reserved port before it ever connects, and says so only on the cause.
    const e = Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") });
    expect(transportFailure(e, "http://host:1")).toBe("couldn't reach the agent runtime at http://host:1 (bad port)");
  });

  it("falls back to the wrapper rather than saying undefined", () => {
    expect(transportFailure(new TypeError("fetch failed"), "http://host:8080")).toBe(
      "couldn't reach the agent runtime at http://host:8080 (fetch failed)",
    );
  });
});
