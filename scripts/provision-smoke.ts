// Provision smoke (run manually; needs host podman + the built image):
//
//   podman build -t localhost/tonoman/base:latest       -f images/base/Dockerfile .
//   podman build -t localhost/tonoman/claudecode:latest -f images/claudecode/Dockerfile .
//   npx tsx scripts/provision-smoke.ts
//
// Proves the roster-provision path that can't be unit-tested without podman: `tonoman
// create agent` mints a GUID, scaffolds <root>/<guid>/{config,memory,identity}, and
// brings up a REAL sandbox on the minimal non-privileged tonoman/claudecode image — then
// that the container is exec-able (the harness path: `podman exec … claude --version`).
//
// SAFETY: runs entirely inside a THROWAWAY env (TONOMAN_ENV=smoke → ~/.tonoman-smoke +
// container suffix -smoke), asserts the target is not "cody", and always tears down its
// container AND its env dir. NOT part of `npm test` (no podman in CI).

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

process.env.TONOMAN_ENV = "smoke"; // isolate everything before importing the CLI seams

import { runCreateAgent } from "../src/agentcmd";
import { containerState, stopContainer } from "../src/lifecycle";
import { Store } from "../src/registry";

const ENV = "smoke";
const NAME = "tonoman-prov-smoke"; // throwaway; never a real agent
const NAME2 = "tonoman-prov-smoke-2"; // second agent for the --from seed test
const CONTAINER = `${NAME}-${ENV}`; // env suffix → cody can never be the target
const CONTAINER2 = `${NAME2}-${ENV}`;
const ROOT = path.join(os.homedir(), `.tonoman-${ENV}`);
const CFG = path.join(ROOT, "settings.json");

let failures = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => { console.log(`  FAIL  ${m}`); failures++; };
const podman = (args: string[]): Promise<number> =>
  new Promise((resolve) => execFile("podman", args, { windowsHide: true }, (err) => resolve(err ? 1 : 0)));
const podmanOut = (args: string[]): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => execFile("podman", args, { windowsHide: true }, (err, so) => resolve({ code: err ? 1 : 0, out: so?.toString() ?? "" })));
const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

async function cleanup() {
  await podman(["rm", "-f", CONTAINER]);
  await podman(["rm", "-f", CONTAINER2]);
  await fs.rm(ROOT, { recursive: true, force: true });
}

async function main() {
  console.log("roster-provision smoke (TONOMAN_ENV=smoke)\n");
  if (CONTAINER === "cody" || NAME === "cody") throw new Error("refusing to run the provision smoke against the live agent");

  await cleanup(); // clean any leftover from a prior run

  try {
    // 1. create agent → real sandbox on the minimal image, fresh env bootstrapped.
    console.log("[1] tonoman create agent (fresh smoke env)");
    await runCreateAgent(CFG, ENV, [NAME, "--login", "--role", "smoke-test agent"]);
    if ((await containerState(CONTAINER)) === "running") pass(`created → ${CONTAINER} running`);
    else { fail(`expected ${CONTAINER} running after create`); return; }

    // 2. scaffold: per-agent dirs + seeded identity exist under the env root.
    console.log("[2] per-agent scaffold under the env root");
    const reg = await new Store(path.join(ROOT, "agents.json")).load();
    const row = reg.find((a) => a.name === NAME);
    if (row) pass(`agents.json row (guid ${row.guid})`); else { fail("no agents.json row"); return; }
    const base = path.join(ROOT, row.guid);
    for (const sub of ["config", "memory", path.join("memory", "incoming"), "identity"]) {
      if (await exists(path.join(base, sub))) pass(`scaffolded ${sub}/`); else fail(`missing ${sub}/`);
    }
    if (await exists(path.join(base, "identity", "AGENTS.md"))) pass("seeded identity/AGENTS.md"); else fail("missing identity/AGENTS.md");

    // 3. roster written with the BASE container name (env suffix applied at runtime).
    const cfg = JSON.parse(await fs.readFile(CFG, "utf8"));
    const entry = (cfg.agents ?? []).find((a: { name: string }) => a.name === NAME);
    if (entry && entry.container === NAME) pass("settings.json roster entry (base container name)"); else fail("roster entry missing/wrong container name");

    // 4. exec-able: the harness path works inside the running sandbox.
    console.log("[3] container is exec-able (harness path)");
    const v = await podmanOut(["exec", CONTAINER, "claude", "--version"]);
    if (v.code === 0 && /\d+\.\d+/.test(v.out)) pass(`podman exec claude --version → ${v.out.trim()}`); else fail(`claude --version failed: ${v.out.trim()}`);

    // 5. adopt-safe: re-create with the same name refuses (never clobbers).
    console.log("[4] adopt-safe: re-create refuses");
    let refused = false;
    try { await runCreateAgent(CFG, ENV, [NAME, "--login"]); } catch { refused = true; }
    if (refused) pass("second create rejected (name already exists)"); else fail("second create should refuse");

    // 5b. --from: seed a SECOND agent's config volume from the first (the quick auth
    //     path). Drop a marker into A's config, then create B --from A, and assert the
    //     marker landed in B's own config (a same-harness one-time copy).
    console.log("[4b] --from seeds creds from an existing same-harness agent");
    await fs.writeFile(path.join(base, "config", "SEED_MARKER"), "from-A\n", "utf8");
    await runCreateAgent(CFG, ENV, [NAME2, "--from", NAME]);
    const reg2 = await new Store(path.join(ROOT, "agents.json")).load();
    const rowB = reg2.find((a) => a.name === NAME2);
    if (rowB && (await containerState(CONTAINER2)) === "running") pass(`--from created ${CONTAINER2} running`); else { fail("--from did not bring up B"); return; }
    if (rowB && (await exists(path.join(ROOT, rowB.guid, "config", "SEED_MARKER")))) pass("B's config volume was seeded from A (creds copied)"); else fail("--from did NOT seed B's config from A");

    // 6. stop → stopped, still exists (stop ≠ rm).
    console.log("[5] stop ≠ rm");
    if ((await stopContainer(CONTAINER)) === true) pass("stopped a running sandbox"); else fail("stop should report true");
    if ((await containerState(CONTAINER)) === "stopped") pass("state=stopped (exists, not removed)"); else fail("expected stopped, not absent");
  } finally {
    await cleanup();
    console.log(`  ----  torn down ${CONTAINER} + ${ROOT}`);
  }

  console.log(`\n${failures === 0 ? "OK — provision smoke passed" : `FAILED — ${failures} check(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`smoke error: ${(e as Error).message}`); process.exit(1); });
