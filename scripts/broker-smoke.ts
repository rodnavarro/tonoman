// Broker smoke (run manually; needs a working host podman):
//
//   npx tsx scripts/broker-smoke.ts
//
// Proves the two A13 invariants that can't be unit-tested without podman:
//   1. an escalation (--privileged) is DENIED before anything is spawned, and
//   2. an agent-view bind path is rewritten to the host path and the host podman
//      actually mounts it (the #1 Windows/WSL port risk).
//
// It is NOT part of `npm test` (which must stay green with no podman installed).

import { brokerRun, DenyError } from "../src/runtime/broker";
import type { Policy } from "../src/runtime/policy";

const IMG = "docker.io/library/alpine:latest"; // fully-qualified: no short-name prompt

// A grant mapping the sandbox view to a real host directory on this machine.
const policy: Policy = {
  guid: "7f6a1b6e0c470ac1",
  grants: [{ agentPath: "/root/files/acme", hostPath: "/host/acme" }],
};

let failures = 0;
function pass(msg: string) { console.log(`  PASS  ${msg}`); }
function fail(msg: string) { console.log(`  FAIL  ${msg}`); failures++; }

async function main() {
  console.log("A13 broker smoke\n");

  // 1. Escalation is denied — and nothing is spawned.
  console.log("[1] --privileged is denied before spawn");
  try {
    await brokerRun(policy, ["run", "--rm", "--privileged", IMG, "true"]);
    fail("--privileged was NOT denied");
  } catch (e) {
    if (e instanceof DenyError) pass(`denied: ${e.message}`);
    else fail(`wrong error: ${(e as Error).message}`);
  }

  // 2. A mount outside every grant is denied.
  console.log("[2] a bind outside all grants is denied");
  try {
    await brokerRun(policy, ["run", "--rm", "-v", "/etc:/host-etc:ro", IMG, "true"]);
    fail("out-of-grant bind was NOT denied");
  } catch (e) {
    if (e instanceof DenyError) pass(`denied: ${e.message}`);
    else fail(`wrong error: ${(e as Error).message}`);
  }

  // 3. Agent-view path is rewritten and the host podman actually mounts it.
  console.log("[3] agent-view bind is rewritten to host path and mounted");
  try {
    const r = await brokerRun(
      policy,
      ["run", "--rm", "-v", "/root/files/acme:/work:ro", IMG, "ls", "/work"],
    );
    console.log(`      rewritten argv: podman ${r.authorizedArgv.join(" ")}`);
    if (!r.authorizedArgv.includes("/host/acme:/work:ro")) {
      fail("argv was not rewritten to the host path");
    } else if (r.code !== 0) {
      fail(`host podman exit ${r.code}: ${r.stderr.trim()}`);
    } else {
      pass(`mounted; /work listing had ${r.stdout.trim().split(/\s+/).filter(Boolean).length} entries`);
    }
  } catch (e) {
    fail(`unexpected error: ${(e as Error).message}`);
  }

  // 4. The non-privileged default container runs (no escalation flag needed).
  console.log("[4] non-privileged container runs by default");
  try {
    const r = await brokerRun(policy, ["run", "--rm", IMG, "echo", "ok"]);
    if (r.code === 0 && r.stdout.includes("ok")) pass("ran non-privileged");
    else fail(`exit ${r.code}: ${r.stderr.trim()}`);
  } catch (e) {
    fail(`unexpected error: ${(e as Error).message}`);
  }

  console.log(`\n${failures === 0 ? "OK — all broker invariants hold" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
