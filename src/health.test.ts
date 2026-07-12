import { describe, it, expect } from "vitest";
import { Registry, serve, fetchReport, render, type Service } from "./health";

const sig = () => new AbortController().signal;
const svc = (s: Partial<Service> & Pick<Service, "name" | "kind" | "status">): Service => s;

describe("health Registry — list + sort + overall (health-list)", () => {
  it("lists every registered service, substrate before agent, then by name", async () => {
    const reg = new Registry();
    reg.add(() => svc({ name: "container", kind: "agent", agent: "cody", status: "ok", detail: "running" }));
    reg.add(() => svc({ name: "memory", kind: "substrate", status: "ok" }));
    reg.add(() => svc({ name: "control", kind: "substrate", status: "ok" }));
    const rep = await reg.snapshot(sig());
    expect(rep.services.map((s) => `${s.kind}/${s.name}`)).toEqual(["substrate/control", "substrate/memory", "agent/container"]);
    expect(rep.overall).toBe("ok");
  });

  it("overall is the worst status across services (down > degraded > unknown > ok)", async () => {
    const reg = new Registry();
    reg.add(() => svc({ name: "a", kind: "substrate", status: "ok" }));
    reg.add(() => svc({ name: "b", kind: "substrate", status: "degraded" }));
    expect((await reg.snapshot(sig())).overall).toBe("degraded");
    reg.add(() => svc({ name: "c", kind: "agent", status: "down" }));
    expect((await reg.snapshot(sig())).overall).toBe("down");
  });

  it("renders an aligned table with a header and overall line", async () => {
    const reg = new Registry();
    reg.add(() => svc({ name: "memory", kind: "substrate", status: "ok", detail: "C:/x" }));
    const out = render(await reg.snapshot(sig()));
    expect(out).toContain("KIND");
    expect(out).toContain("memory");
    expect(out.trimEnd().endsWith("overall: ok")).toBe(true);
  });
});

describe("health Registry — autoregister + no-tokens invariant", () => {
  it("a newly registered check shows up automatically (health-autoregister)", async () => {
    const reg = new Registry();
    reg.add(() => svc({ name: "a", kind: "substrate", status: "ok" }));
    expect((await reg.snapshot(sig())).services).toHaveLength(1);
    reg.add(() => svc({ name: "b", kind: "agent", status: "ok" })); // added after first snapshot
    expect((await reg.snapshot(sig())).services).toHaveLength(2);
  });

  it("a snapshot only runs the registered checks — no model/LLM in the path (health-no-tokens)", async () => {
    let calls = 0;
    const reg = new Registry();
    reg.add(() => {
      calls++;
      return svc({ name: "x", kind: "substrate", status: "ok" });
    });
    await reg.snapshot(sig());
    await reg.snapshot(sig());
    expect(calls).toBe(2); // health = invoking registered checks; nothing else (no tokens spent)
  });
});

describe("health API round-trip (health-live-api)", () => {
  it("serves the snapshot as JSON; the thin client fetches it; non-/health is 404", async () => {
    const reg = new Registry();
    reg.add(() => svc({ name: "memory", kind: "substrate", status: "ok" }));
    const ac = new AbortController();
    const port: number = await new Promise((res) => {
      void serve("127.0.0.1:0", reg, ac.signal, (p) => res(p)); // ephemeral port
    });
    try {
      const rep = await fetchReport(`127.0.0.1:${port}`);
      expect(rep.overall).toBe("ok");
      expect(rep.services[0].name).toBe("memory");
      const r = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(r.status).toBe(404);
    } finally {
      ac.abort();
    }
  });

  it("POST /shutdown is the loopback admin endpoint that `tonoman down` triggers (cli-up-down)", async () => {
    const reg = new Registry();
    reg.add(() => svc({ name: "memory", kind: "substrate", status: "ok" }));
    const ac = new AbortController();
    let shutdownCalls = 0;
    const port: number = await new Promise((res) => {
      void serve("127.0.0.1:0", reg, ac.signal, (p) => res(p), () => shutdownCalls++);
    });
    try {
      const r = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
      expect(r.status).toBe(200);
      expect((await r.json()).stopping).toBe(true);
      expect(shutdownCalls).toBe(1); // onShutdown fired — gateway aborts → stops agents
      // a GET to /shutdown is not the admin verb → falls through to 404
      expect((await fetch(`http://127.0.0.1:${port}/shutdown`)).status).toBe(404);
    } finally {
      ac.abort();
    }
  });
});
