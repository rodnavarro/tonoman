// Lifecycle smoke (run manually; needs a working host podman):
//
//   npx tsx scripts/lifecycle-smoke.ts
//
// Proves the cli-up-down container lifecycle that can't be unit-tested without podman:
//   start-if-stopped (adopt), stop (graceful), no-op when already running, and the
//   ABSENT path — all WITHOUT ever removing a container (stop ≠ rm).
//
// SAFETY: runs against a THROWAWAY container with a fixed smoke name, asserts the
// target is not "cody" (never touches the live agent), and always tears its own
// container down at the end. It is NOT part of `npm test` (no podman in CI).

import { execFile } from "node:child_process";
import { containerState, ensureStarted, stopContainer } from "../src/lifecycle";

const NAME = "tonoman-lifecycle-smoke"; // throwaway; must never be a real agent
const IMG = "docker.io/library/alpine:latest"; // fully-qualified: no short-name prompt

let failures = 0;
function pass(msg: string) { console.log(`  PASS  ${msg}`); }
function fail(msg: string) { console.log(`  FAIL  ${msg}`); failures++; }

function podman(args: string[]): Promise<number> {
  return new Promise((resolve) => execFile("podman", args, { windowsHide: true }, (err) => resolve(err ? 1 : 0)));
}

async function main() {
  console.log("cli-up-down lifecycle smoke\n");

  // Safety floor: never run this against the live agent.
  if (NAME === "cody") throw new Error("refusing to run the lifecycle smoke against the live agent");

  await podman(["rm", "-f", NAME]); // clean any leftover from a prior run

  try {
    // 0. ABSENT before anything exists: ensureStarted reports absent (never creates),
    //    stopContainer is a no-op.
    console.log("[0] absent container");
    if ((await containerState(NAME)) === "absent") pass("state=absent before create"); else fail("expected absent");
    if ((await ensureStarted(NAME)) === "absent") pass("ensureStarted=absent (does NOT create)"); else fail("ensureStarted should report absent, not create");
    if ((await stopContainer(NAME)) === false) pass("stopContainer=false on absent"); else fail("stop should no-op on absent");

    // Create a throwaway container directly (provisioning is a separate concern; here we
    // only test adopt/start/stop of an existing one).
    console.log("[1] create throwaway, then adopt/stop");
    if ((await podman(["run", "-d", "--name", NAME, IMG, "sleep", "3600"])) !== 0) { fail("could not create throwaway container (is podman up? image pullable?)"); return; }
    if ((await containerState(NAME)) === "running") pass("created → running"); else fail("expected running after run");

    // 2. stop (graceful) → stopped, but STILL EXISTS (not removed).
    if ((await stopContainer(NAME)) === true) pass("stopContainer=true (stopped a running one)"); else fail("stop should report true");
    if ((await containerState(NAME)) === "stopped") pass("state=stopped (exists, not removed — stop ≠ rm)"); else fail("expected stopped, not absent");

    // 3. adopt: start-if-stopped → started → running.
    if ((await ensureStarted(NAME)) === "started") pass("ensureStarted=started (adopted the stopped one)"); else fail("expected started");
    if ((await containerState(NAME)) === "running") pass("state=running after adopt"); else fail("expected running");

    // 4. no-op when already running.
    if ((await ensureStarted(NAME)) === "running") pass("ensureStarted=running (no-op when already up)"); else fail("expected running no-op");
  } finally {
    await podman(["rm", "-f", NAME]); // guaranteed teardown
    console.log(`  ----  torn down ${NAME}`);
  }

  console.log(`\n${failures === 0 ? "OK — lifecycle smoke passed" : `FAILED — ${failures} check(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`smoke error: ${(e as Error).message}`); process.exit(1); });
