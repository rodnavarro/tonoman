import { describe, it, expect } from "vitest";
import { ExposeManager, parsePorts, TONOMAN_BUILTIN, type ContainerInfo } from "./expose";
import { makeBrokerExecutor } from "./control";

// ─── parsePorts: podman's "Ports" column → reachable published ports ──────────
describe("parsePorts (devcontainerized-resolve-url)", () => {
  it("parses a single host→container publish", () => {
    expect(parsePorts("0.0.0.0:8081->8080/tcp")).toEqual([
      { hostIP: "0.0.0.0", hostPort: 8081, containerPort: 8080, proto: "tcp" },
    ]);
  });
  it("keeps only entries with a host publish (skips bare and range ports)", () => {
    // localstack-style column: one real publish + a range + an internal-only port.
    const ports = parsePorts("0.0.0.0:4566->4566/tcp, 4510-4559/tcp, 5678/tcp");
    expect(ports).toEqual([{ hostIP: "0.0.0.0", hostPort: 4566, containerPort: 4566, proto: "tcp" }]);
  });
  it("returns nothing for an unpublished container", () => {
    expect(parsePorts("5432/tcp")).toEqual([]);
    expect(parsePorts("")).toEqual([]);
  });
});

// A fake host: a fixed container list + a recording port-forwarder.
function fakeHost(containers: ContainerInfo[], opts: { forwardFails?: boolean } = {}) {
  const forwards: string[] = [];
  return {
    forwards,
    listContainers: async () => containers,
    forward: async (action: "add" | "remove", port: number) => {
      if (opts.forwardFails) throw new Error("netsh: requires elevation");
      forwards.push(`${action}:${port}`);
    },
  };
}

const worker: ContainerInfo = {
  name: "billing-worker",
  ports: [{ hostIP: "0.0.0.0", hostPort: 8081, containerPort: 8080, proto: "tcp" }],
};

describe("ExposeManager — url resolves authority host-side, default-deny (devcontainerized-resolve-url)", () => {
  it("an un-exposed service resolves to the HOST-LOCAL url with a not-exposed note", async () => {
    const h = fakeHost([worker]);
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...h });
    const r = await m.handle(["url", "worker"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("http://localhost:8081"); // host-only until exposed
    expect(r.stdout).not.toContain("192.168.4.80"); // NOT advertised as network-reachable
    expect(r.stdout.toLowerCase()).toMatch(/not exposed|host-only|expose/); // tells the agent how to make it reachable
    expect(h.forwards).toEqual([]); // url never opens a port
  });

  it("matches a compose-style container name by token and reports the host port (not the internal 8080)", async () => {
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...fakeHost([worker]) });
    const r = await m.handle(["url", "worker"]);
    expect(r.stdout).toContain("8081");
    expect(r.stdout).not.toContain(":8080"); // 8080 is container-internal / unpublished
  });

  it("errors clearly when no service matches (never fabricates a url)", async () => {
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...fakeHost([worker]) });
    const r = await m.handle(["url", "nope"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no service");
  });

  it("never invents a route — it returns authority only, no path", async () => {
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...fakeHost([worker]) });
    const r = await m.handle(["url", "worker"]);
    expect(r.stdout).not.toContain("/health"); // the agent probes + appends the path itself
  });
});

describe("ExposeManager — expose/unexpose are brokered, revocable, default-deny (devcontainerized-expose-url)", () => {
  it("expose opens the host port and flips url to the advertised (LAN) host", async () => {
    const h = fakeHost([worker]);
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...h });

    const ex = await m.handle(["expose", "worker"]);
    expect(ex.code).toBe(0);
    expect(h.forwards).toEqual(["add:8081"]); // the broker (not the agent) opened it
    expect(ex.stdout).toContain("http://192.168.4.80:8081"); // now network-reachable
    expect(ex.stdout.toLowerCase()).toMatch(/unexpose|stop exposing/); // tells how to revoke

    // url now reflects the exposed (LAN) authority.
    const after = await m.handle(["url", "worker"]);
    expect(after.stdout).toContain("http://192.168.4.80:8081");
  });

  it("unexpose closes the port and reverts url to host-local (revocable)", async () => {
    const h = fakeHost([worker]);
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...h });
    await m.handle(["expose", "worker"]);
    const un = await m.handle(["unexpose", "worker"]);
    expect(un.code).toBe(0);
    expect(h.forwards).toEqual(["add:8081", "remove:8081"]);
    const after = await m.handle(["url", "worker"]);
    expect(after.stdout).toContain("http://localhost:8081"); // back to host-only
  });

  it("expose fails HONESTLY when the host forward can't be created (no silent success)", async () => {
    const h = fakeHost([worker], { forwardFails: true });
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...h });
    const r = await m.handle(["expose", "worker"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("elevation"); // surfaces the real reason
    // and it must NOT report the service as reachable
    const after = await m.handle(["url", "worker"]);
    expect(after.stdout).toContain("http://localhost:8081");
  });

  it("expose with no published port reports that — nothing to expose", async () => {
    const noPort: ContainerInfo = { name: "db", ports: [] };
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...fakeHost([noPort]) });
    const r = await m.handle(["expose", "db"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/no published port|nothing to expose/);
  });

  it("expose is unambiguous: multiple name matches are refused, not guessed", async () => {
    const a: ContainerInfo = { name: "app-worker", ports: [{ hostIP: "0.0.0.0", hostPort: 9001, containerPort: 80, proto: "tcp" }] };
    const b: ContainerInfo = { name: "job-worker", ports: [{ hostIP: "0.0.0.0", hostPort: 9002, containerPort: 80, proto: "tcp" }] };
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...fakeHost([a, b]) });
    const r = await m.handle(["expose", "worker"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("multiple");
  });

  it("an unknown verb is a usage error, not a pass-through", async () => {
    const m = new ExposeManager({ advertiseHost: "192.168.4.80", ...fakeHost([worker]) });
    const r = await m.handle(["frobnicate", "worker"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("usage");
  });
});

describe("makeBrokerExecutor — routes the tonoman builtin to its handler (not podman)", () => {
  it("dispatches a __tonoman__ argv to the injected handler and returns its result", async () => {
    const exec = makeBrokerExecutor(
      { guid: "g", grants: [] },
      { tonoman: async (args) => ({ code: 0, stdout: "handled:" + args.join(","), stderr: "" }) },
    );
    const res = await exec([TONOMAN_BUILTIN, "expose", "worker"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("handled:expose,worker");
    // audit-safe argv records the builtin, not a secret-bearing podman line.
    expect(res.authorizedArgv).toEqual([TONOMAN_BUILTIN, "expose", "worker"]);
  });

  it("returns a clear error if the builtin is invoked but no handler is wired", async () => {
    const exec = makeBrokerExecutor({ guid: "g", grants: [] });
    const res = await exec([TONOMAN_BUILTIN, "url", "worker"]);
    expect(res.code).not.toBe(0);
    expect(res.error).toBeTruthy();
  });
});
