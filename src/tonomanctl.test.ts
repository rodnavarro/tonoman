// tonomanctl, the installer (worker-pool.md in Tonoman Cloud): a fake platform answers the enrolment,
// a fake podman records what it was asked to do, and the script's whole effect on the machine is
// checked — the credential file and the pod it would start. Needs bash (Git Bash on Windows).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.resolve(__dirname, "../build/tonomanctl/tonomanctl.sh");
// Git's usr/bin/bash, not bin/bash: the latter is a launcher that re-attaches a console and can hang under a test runner.
const bash = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/bash.exe" : "bash";
const haveBash = existsSync(bash) || process.platform !== "win32";

let server: http.Server;
let api = "";
const enrolments: { token: string; version: string }[] = [];
let answer: { status: number; body: unknown } = { status: 201, body: {} };

/** A fake podman: appends its argv to a log and answers what the script expects. */
const FAKE_PODMAN = `#!/usr/bin/env bash
echo "$*" >> "$PODMAN_LOG"
case "$1 $2" in
  "pod exists"|"volume exists") exit 1 ;;
esac
exit 0
`;

/** Runs the script asynchronously: the fake platform lives on this same event loop, and a blocking
 *  spawn would leave curl waiting on a server that can never answer. */
const sh = (args: string[], env: Record<string, string>) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(bash, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on("close", (status) => (clearTimeout(timer), resolve({ status, stdout, stderr })));
  });
const run = (home: string, bin: string, args: string[], env: Record<string, string> = {}) =>
  sh(args, { HOME: home, TONOMAN_HOME: path.join(home, ".tonoman"), PODMAN: path.join(bin, "podman"), PODMAN_LOG: path.join(home, "podman.log"), PATH: process.platform === "win32" ? `${bin.replace(/\//g, "\\")};${process.env.PATH}` : `${bin}:${process.env.PATH}`, ...env });

const toPosix = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/pool/enrol") {
        enrolments.push(JSON.parse(body));
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const machine = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tonomanctl-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "podman"), FAKE_PODMAN, { mode: 0o755 });
  return { home: toPosix(home), bin: toPosix(bin), drop: () => rmSync(home, { recursive: true, force: true }) };
};

describe.skipIf(!haveBash)("tonomanctl", () => {
  it("POOL-ENROLS-WITH-ONE-COMMAND enrol exchanges the token once, keeps the credential readable by the user alone, and brings the pod up on the pool's own queue and namespace", async () => {
    const m = machine();
    try {
      answer = { status: 201, body: { credential: "tpc_secret", pool: { id: "p1", name: "laptop", taskQueue: "pool-p1", temporalNamespace: "pool-p1" }, temporal: { address: "temporal.example.com:7233" }, releases: {} } };
      const r = await run(m.home, m.bin, ["enrol", "tpe_token", "--api", api, "--release", "v0.2.0"]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(enrolments.at(-1)).toEqual({ token: "tpe_token", version: "v0.2.0" });
      const envFile = path.join(m.home, ".tonoman", "pool.env");
      const text = readFileSync(envFile, "utf8");
      expect(text).toContain("TONOMANCLOUD_API_TOKEN=tpc_secret");
      expect(text).toContain("TEMPORAL_NAMESPACE=pool-p1");
      expect(text).toContain("TEMPORAL_TASK_QUEUE=pool-p1");
      expect(text).toContain("TEMPORAL_ADDRESS=temporal.example.com:7233");
      expect(text).toContain(`TONOMANCLOUD_API_URL=${api}`);
      if (process.platform !== "win32") expect(statSync(envFile).mode & 0o077).toBe(0);
      const podman = readFileSync(path.join(m.home, "podman.log"), "utf8");
      expect(podman).toContain("pull -q ghcr.io/rodnavarro/tonoman:v0.2.0");
      expect(podman).toContain("pod create --name tonoman");
      expect(podman).toMatch(/run -d --pod tonoman --name tonoman-auth .* node \/opt\/tonoman\/dist\/cli\.js runtime/);
      expect(podman).toMatch(/run -d --pod tonoman --name tonoman-worker .*--env-file .*pool\.env .*node \/opt\/tonoman\/dist\/cli\.js worker/);
      expect(podman).toContain("TONOMAN_VERSION=v0.2.0");
      // The credential rides in the env file, never on the podman command line (a process list would show it).
      expect(podman).not.toContain("tpc_secret");
    } finally {
      m.drop();
    }
  });

  it("POOL-ENROLS-WITH-ONE-COMMAND a spent or expired token is refused with the way out, and nothing is saved", async () => {
    const m = machine();
    try {
      answer = { status: 404, body: { error: "not open" } };
      const r = await run(m.home, m.bin, ["enrol", "tpe_old", "--api", api]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/Mint a new command in the Hub/);
      expect(existsSync(path.join(m.home, ".tonoman", "pool.env"))).toBe(false);
      // podman was only asked whether it is there; nothing was pulled or started.
      const log = existsSync(path.join(m.home, "podman.log")) ? readFileSync(path.join(m.home, "podman.log"), "utf8") : "";
      expect(log).not.toMatch(/pull|pod create|run /);
    } finally {
      m.drop();
    }
  });

  it("POOL-INSTALLER-CHECKS-FIRST without podman it says what is missing and changes nothing", async () => {
    const home = toPosix(mkdtempSync(path.join(os.tmpdir(), "tonomanctl-")));
    try {
      const r = await sh(["enrol", "tpe_x", "--api", api], { HOME: home, TONOMAN_HOME: `${home}/.tonoman`, PODMAN: "podman-that-is-not-here" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/podman is not installed/);
      expect(existsSync(path.join(home, ".tonoman"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("POOL-SURVIVES-REBOOT update moves to the release named and never on its own; uninstall removes the logins and the credential", async () => {
    const m = machine();
    try {
      answer = { status: 201, body: { credential: "tpc_secret", pool: { id: "p1", name: "laptop", taskQueue: "q", temporalNamespace: "n" }, temporal: { address: "t:7233" } } };
      expect((await run(m.home, m.bin, ["enrol", "tpe_token", "--api", api, "--release", "v0.2.0", "--no-up"])).status).toBe(0);
      expect((await run(m.home, m.bin, ["update"])).status).not.toBe(0); // no release named: nothing happens
      expect((await run(m.home, m.bin, ["update", "v0.3.0"])).status).toBe(0);
      expect(readFileSync(path.join(m.home, ".tonoman", "pool.env"), "utf8")).toContain("TONOMAN_RELEASE=v0.3.0");
      expect(readFileSync(path.join(m.home, "podman.log"), "utf8")).toContain("pull -q ghcr.io/rodnavarro/tonoman:v0.3.0");
      expect((await run(m.home, m.bin, ["uninstall"])).status).toBe(0);
      const log = readFileSync(path.join(m.home, "podman.log"), "utf8");
      for (const v of ["tonoman-claude", "tonoman-codex", "tonoman-homes", "tonoman-state"]) expect(log).toContain(`volume rm -f ${v}`);
      expect(existsSync(path.join(m.home, ".tonoman", "pool.env"))).toBe(false);
    } finally {
      m.drop();
    }
  });
});
