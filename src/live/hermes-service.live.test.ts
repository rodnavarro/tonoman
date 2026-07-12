// LIVE integration test for `hermes-live` (docs/scenarios/live/hermes-service.md).
// Proves what fakes can't: a SERVICE-mode agent (svc-self-channeled) actually boots under
// Tonoman on the Hermes backend (backend-hermes) — long-lived server, declared CLI installed
// at boot, healthy on its port WITHOUT spending model tokens, clean teardown. Real container.
//
// Run on demand: `npm run test:live -- src/live/hermes-service.live.test.ts`
// Gated by TONOMAN_LIVE=1; SKIPS (doesn't fail) when the tonoman/hermes image is absent.
// Uses a throwaway env (its own ~/.tonoman-<env>) with guaranteed teardown — never the live plane.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCreateAgent } from "../agentcmd";
import { containerState, stopContainer } from "../lifecycle";

const IMAGE = "localhost/tonoman/hermes:latest";
const LIVE = process.env.TONOMAN_LIVE === "1";

function imagePresent(): boolean {
  try {
    execFileSync("podman", ["image", "exists", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const ready = LIVE && imagePresent();
if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(`[live] SKIPPING hermes-live — set TONOMAN_LIVE=1 and build ${IMAGE} (got LIVE=${LIVE}, image=${imagePresent()}).`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls the published host port until the server answers (any HTTP status) or the deadline. */
async function waitForPort(port: number, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (r.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await delay(2000);
  }
  return false;
}

// Deterministic, env-isolated names (no Date/random) so re-runs don't collide and we clean up.
const env = `hsvc${process.pid}`;
const name = "svc";
const container = `${name}-${env}`;
const port = 19000 + (process.pid % 1000);
const root = path.join(os.homedir(), `.tonoman-${env}`);
const cfgPath = path.join(root, "settings.json");
const MARKER = "declared-cli"; // the "declared CLI" the boot-time setup installs (cfg-agent-tools)

describe.skipIf(!ready)("hermes-live (service backend)", () => {
  beforeAll(async () => {
    try {
      execFileSync("podman", ["rm", "-f", container], { stdio: "ignore" });
    } catch {
      /* none to clean */
    }
    // `tonoman create agent` provisions the service container (podmanRunArgs service variant:
    // boots `gateway`, publishes the port, dashboard env) and runs the declared setup at boot.
    await runCreateAgent(cfgPath, env, [
      name,
      "--harness",
      "hermes",
      "--port",
      String(port),
      "--setup",
      `printf '#!/bin/sh\\necho ${MARKER}-ok\\n' > /usr/local/bin/${MARKER} && chmod +x /usr/local/bin/${MARKER}`,
    ]);
  }, 180_000);

  afterAll(async () => {
    try {
      execFileSync("podman", ["rm", "-f", container], { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("boots and stays up — a long-lived server, not exec-per-turn (svc-self-channeled)", async () => {
    expect(await containerState(container)).toBe("running");
    await delay(2500);
    expect(await containerState(container)).toBe("running"); // still up ⇒ long-lived, not a one-shot
  });

  it("the declared CLI is installed at boot and on PATH (cfg-agent-tools)", () => {
    // Throws (failing the test) if the setup didn't put the marker on PATH.
    const out = execFileSync("podman", ["exec", container, "sh", "-lc", `command -v ${MARKER}`], { encoding: "utf8" });
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it("is healthy on its port WITHOUT spending model tokens (health-no-tokens)", async () => {
    expect(await waitForPort(port, 90_000)).toBe(true);
  });

  it("tears down clean — `down` stops it (adopt-safe), no container left behind", async () => {
    await stopContainer(container);
    expect(await containerState(container)).toBe("stopped"); // stopped, not rm'd (volumes persist)
    execFileSync("podman", ["rm", "-f", container], { stdio: "ignore" }); // teardown removes it entirely
    expect(await containerState(container)).toBe("absent");
  });
});
