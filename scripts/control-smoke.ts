// Control-channel end-to-end smoke (run manually; needs a working host podman):
//
//   npx tsx scripts/control-smoke.ts
//
// Proves the WHOLE substrate path that the in-container agent uses, host-side:
//   controlRequest (what the agent's `podman` shim does)
//        → request file on the shared mount
//        → serveControl + makeBrokerExecutor (host broker)
//        → authorize + rewrite + exec real host podman
//        → response file
//        → controlRequest returns it
// The only difference from production is *where* controlRequest runs (here: host;
// there: inside the sandbox) — identical code, identical file transport.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { serveControl, controlRequest, makeBrokerExecutor } from "../src/runtime/control";
import type { Policy } from "../src/runtime/policy";

const IMG = "docker.io/library/alpine:latest";
const policy: Policy = {
  guid: "7f6a1b6e0c470ac1",
  grants: [{ agentPath: "/root/files/acme", hostPath: "/host/acme" }],
};

let failures = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => { console.log(`  FAIL  ${m}`); failures++; };

async function main() {
  console.log("A13 control-channel e2e smoke\n");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tonoman-ctl-smoke-"));
  const ac = new AbortController();

  // Host broker: watches the shared dir, authorizes + execs real podman.
  const server = serveControl(dir, makeBrokerExecutor(policy), {
    intervalMs: 100,
    signal: ac.signal,
    onReady: (d) => console.log(`  broker watching ${d}\n`),
  });

  try {
    // [1] agent asks to mount a grant and list it — full round trip, path rewritten host-side.
    console.log("[1] agent → broker: mount a grant and list it");
    const r1 = await controlRequest(
      dir,
      ["run", "--rm", "-v", "/root/files/acme:/work:ro", IMG, "ls", "/work"],
      { timeoutMs: 120_000, pollMs: 150 },
    );
    if (r1.code === 0 && r1.stdout.trim().length > 0) {
      pass(`stack reachable; /work had ${r1.stdout.trim().split(/\s+/).filter(Boolean).length} entries`);
    } else {
      fail(`code=${r1.code} stderr=${r1.stderr.trim()}`);
    }

    // [2] agent asks to escalate — broker denies over the channel; nothing runs.
    console.log("[2] agent → broker: escalation is denied over the channel");
    const r2 = await controlRequest(dir, ["run", "--rm", "--privileged", IMG, "true"], { timeoutMs: 10_000 });
    if (r2.denied && r2.code === 126) pass(`denied over channel: ${r2.error}`);
    else fail(`expected denial, got code=${r2.code} denied=${r2.denied}`);

    // [3] a plain non-privileged run round-trips fine.
    console.log("[3] agent → broker: non-privileged echo round-trips");
    const r3 = await controlRequest(dir, ["run", "--rm", IMG, "echo", "hello-from-broker"], { timeoutMs: 60_000 });
    if (r3.code === 0 && r3.stdout.includes("hello-from-broker")) pass("ran non-privileged via channel");
    else fail(`code=${r3.code} stderr=${r3.stderr.trim()}`);
  } finally {
    ac.abort();
    await server;
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "OK — substrate path holds end-to-end" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
