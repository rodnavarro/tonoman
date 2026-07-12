import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  processRequests,
  controlRequest,
  makeBrokerExecutor,
  type Executor,
  type ControlResponse,
} from "./control";
import type { Policy } from "./policy";
import { Ledger, type LedgerEntry } from "./ledger";

let dir: string;
let reqDir: string;
let resDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tonoman-control-"));
  reqDir = path.join(dir, "requests");
  resDir = path.join(dir, "responses");
  await fs.mkdir(reqDir, { recursive: true });
  await fs.mkdir(resDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Writes a request file the way the client does. */
async function writeReq(id: string, argv: string[]) {
  await fs.writeFile(path.join(reqDir, `${id}.json`), JSON.stringify({ id, argv }), "utf8");
}

describe("processRequests", () => {
  it("executes a request and writes the matching response, then removes the request", async () => {
    await writeReq("abc", ["ps"]);
    const fake: Executor = async (argv) => ({
      id: "",
      code: 0,
      stdout: `ran: ${argv.join(" ")}`,
      stderr: "",
    });

    const n = await processRequests(reqDir, resDir, fake);
    expect(n).toBe(1);

    const res = JSON.parse(await fs.readFile(path.join(resDir, "abc.json"), "utf8")) as ControlResponse;
    expect(res.id).toBe("abc");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("ran: ps");

    // request consumed
    await expect(fs.readFile(path.join(reqDir, "abc.json"))).rejects.toThrow();
  });

  it("ignores non-.json and .tmp files", async () => {
    await fs.writeFile(path.join(reqDir, "note.txt"), "x");
    await fs.writeFile(path.join(reqDir, "half.json.tmp"), "{");
    const n = await processRequests(reqDir, resDir, async () => ({ id: "", code: 0, stdout: "", stderr: "" }));
    expect(n).toBe(0);
  });

  it("returns 0 when the requests dir does not exist", async () => {
    const n = await processRequests(path.join(dir, "nope"), resDir, async () => ({ id: "", code: 0, stdout: "", stderr: "" }));
    expect(n).toBe(0);
  });

  it("surfaces an executor throw as an error response (does not lose the request slot)", async () => {
    await writeReq("boom", ["run", "x"]);
    const n = await processRequests(reqDir, resDir, async () => {
      throw new Error("exec exploded");
    });
    expect(n).toBe(1);
    const res = JSON.parse(await fs.readFile(path.join(resDir, "boom.json"), "utf8")) as ControlResponse;
    expect(res.code).toBe(127);
    expect(res.error).toContain("exec exploded");
  });
});

describe("makeBrokerExecutor — policy enforcement (hermetic: deny short-circuits before spawn)", () => {
  const policy: Policy = {
    guid: "deadbeef",
    grants: [{ agentPath: "/root/files/acme", hostPath: "/host/acme" }],
  };

  it("returns a denied response for an escalation, without spawning podman", async () => {
    const exec = makeBrokerExecutor(policy);
    const res = await exec(["run", "--privileged", "img"]);
    expect(res.denied).toBe(true);
    expect(res.code).toBe(126);
    expect(res.error).toContain("--privileged");
  });

  it("returns a denied response for an out-of-grant bind", async () => {
    const exec = makeBrokerExecutor(policy);
    const res = await exec(["run", "-v", "/etc:/etc", "img"]);
    expect(res.denied).toBe(true);
    expect(res.error).toContain("outside the agent's grants");
  });

  it("end-to-end through the channel: a denied request yields a denied response file", async () => {
    await writeReq("deny1", ["run", "--privileged", "img"]);
    await processRequests(reqDir, resDir, makeBrokerExecutor(policy));
    const res = JSON.parse(await fs.readFile(path.join(resDir, "deny1.json"), "utf8")) as ControlResponse;
    expect(res.id).toBe("deny1");
    expect(res.denied).toBe(true);
  });
});

describe("processRequests + Ledger — brokered ops are accounted (gw-brokered-op-accountable)", () => {
  async function ledgerLines(file: string): Promise<LedgerEntry[]> {
    const raw = await fs.readFile(file, "utf8");
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
  }

  it("records op-start + op-end for a completed brokered command", async () => {
    const file = path.join(dir, "ledger.jsonl");
    const led = new Ledger({ file });
    await writeReq("op1", ["compose", "up", "-d"]);
    const fake: Executor = async () => ({ id: "", code: 0, stdout: "", stderr: "", authorizedArgv: ["compose", "up", "-d"] });

    await processRequests(reqDir, resDir, fake, led);
    expect(led.inFlight()).toEqual([]); // synchronous op completed → nothing in-flight

    const ls = await ledgerLines(file);
    expect(ls.map((l) => l.phase)).toEqual(["op-start", "op-end"]);
    expect(ls[1].code).toBe(0);
  });

  it("THE CATCH end-to-end: a turn that ends while a brokered op is still running flags it orphaned", async () => {
    const file = path.join(dir, "ledger.jsonl");
    const led = new Ledger({ file });
    await writeReq("restore", ["run", "postgres:17"]);

    // A long restore that hasn't returned yet — models the agent backgrounding it.
    let release!: () => void;
    const slow: Executor = () =>
      new Promise<ControlResponse>((res) => {
        release = () => res({ id: "", code: 0, stdout: "", stderr: "" });
      });

    const pending = processRequests(reqDir, resDir, slow, led);
    // wait until the op is recorded in-flight (op-start written before exec)
    for (let i = 0; i < 100 && led.inFlight().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(led.inFlight().map((e) => e.id)).toEqual(["restore"]);

    // The turn ends here, mid-op → the gateway flags the orphan.
    const orphans = await led.endTurn("tg:42");
    expect(orphans).toEqual(["restore"]);

    release();
    await pending;
    const ls = await ledgerLines(file);
    expect(ls.some((l) => l.phase === "op-orphaned" && l.id === "restore")).toBe(true);
  });
});

describe("controlRequest ↔ listener round trip", () => {
  it("the client gets the response the listener writes (and both files are cleaned up)", async () => {
    const fake: Executor = async (argv) => ({ id: "", code: 0, stdout: argv.join("|"), stderr: "" });

    // Client writes a request and polls; a driver pumps the listener concurrently.
    const clientP = controlRequest(dir, ["compose", "up", "-d"], { timeoutMs: 5_000, pollMs: 20 });
    const driver = (async () => {
      for (let i = 0; i < 50; i++) {
        if ((await processRequests(reqDir, resDir, fake)) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    const [res] = await Promise.all([clientP, driver]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("compose|up|-d");

    // response consumed by the client
    expect(await fs.readdir(resDir)).toEqual([]);
    // request consumed by the listener
    expect(await fs.readdir(reqDir)).toEqual([]);
  });

  it("times out if no listener answers", async () => {
    await expect(controlRequest(dir, ["ps"], { timeoutMs: 150, pollMs: 20 })).rejects.toThrow(/timed out/);
  });
});
