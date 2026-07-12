import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { brokerRun } from "./broker";
import type { Policy } from "./policy";

const POLICY: Policy = { guid: "deadbeef0000", grants: [] };

/** A fake child process the tests drive directly (no real podman). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinData = "";
  stdinEnded = false;
  killed = false;
  stdin = {
    write: (s: string) => {
      this.stdinData += s;
    },
    end: () => {
      this.stdinEnded = true;
    },
  };
  kill(_sig?: string): void {
    this.killed = true;
    this.emit("close", null); // a killed process closes with no code
  }
}

/** Builds an injected spawn that hands the test the child it created. */
function fakeSpawner(): { spawnFn: typeof spawn; child: () => FakeChild } {
  let created: FakeChild | undefined;
  const spawnFn = ((_cmd: string, _args: string[], _opts: unknown) => {
    created = new FakeChild();
    return created;
  }) as unknown as typeof spawn;
  return { spawnFn, child: () => created! };
}

describe("brokerRun — stdin plumbing (devcontainerized-broker-stdin)", () => {
  it("feeds piped stdin to the host command then closes it", async () => {
    const { spawnFn, child } = fakeSpawner();
    const p = brokerRun(POLICY, ["exec", "-i", "pg", "psql"], { _spawn: spawnFn, stdin: "SELECT 1;\n" });
    // stdin is fed synchronously right after spawn
    expect(child().stdinData).toBe("SELECT 1;\n");
    expect(child().stdinEnded).toBe(true);
    child().emit("close", 0);
    const r = await p;
    expect(r.code).toBe(0);
  });

  it("closes stdin immediately (EOF) when none is piped — so `-i` does not hang", async () => {
    const { spawnFn, child } = fakeSpawner();
    const p = brokerRun(POLICY, ["exec", "-i", "pg", "psql"], { _spawn: spawnFn });
    expect(child().stdinData).toBe(""); // nothing written
    expect(child().stdinEnded).toBe(true); // but stdin WAS closed → command gets EOF, returns
    child().emit("close", 1);
    const r = await p;
    expect(r.code).toBe(1);
  });
});

describe("brokerRun — timeout (devcontainerized-broker-timeout)", () => {
  it("kills a hung op and returns a non-zero timeout result within the bound", async () => {
    const { spawnFn, child } = fakeSpawner();
    // The child never closes on its own; only the broker's timeout can end it.
    const r = await brokerRun(POLICY, ["exec", "pg", "sleep", "999"], { _spawn: spawnFn, timeoutMs: 40 });
    expect(child().killed).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124); // conventional timeout exit code
    expect(r.stderr).toMatch(/timed out/i);
  });

  it("a normal close before the timeout is not flagged as timed out", async () => {
    const { spawnFn, child } = fakeSpawner();
    const p = brokerRun(POLICY, ["ps"], { _spawn: spawnFn, timeoutMs: 5_000 });
    child().stdout.emit("data", Buffer.from("ok"));
    child().emit("close", 0);
    const r = await p;
    expect(r.timedOut).toBeFalsy();
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ok");
    expect(child().killed).toBe(false);
  });
});
