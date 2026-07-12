import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { tcpProxy } from "./proxy";

/** Stands up a throwaway HTTP origin on 127.0.0.1; returns its port + a stop fn. */
function origin(body: string): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_q, r) => r.end(body));
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      resolve({ port: p, stop: () => new Promise((res) => srv.close(() => res())) });
    });
  });
}

function get(port: number, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: "/" }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
  });
}

describe("tcpProxy — pipes a LAN-bound listener to a loopback service (devcontainerized-expose-url)", () => {
  it("forwards traffic from the proxy port to the target (and survives multiple requests)", async () => {
    const o = await origin("served-via-proxy");
    // Distinct listen port (0 → ephemeral) vs target port — the real expose binds the
    // LAN IP on the SAME port number, which doesn't collide with 127.0.0.1:<port>.
    const proxy = await tcpProxy("127.0.0.1", 0, "127.0.0.1", o.port);
    expect(await get(proxy.port)).toBe("served-via-proxy");
    expect(await get(proxy.port)).toBe("served-via-proxy"); // proxy stays up across connections
    await proxy.close();
    await o.stop();
  });

  it("close() stops accepting — the forward is revocable", async () => {
    const o = await origin("x");
    const proxy = await tcpProxy("127.0.0.1", 0, "127.0.0.1", o.port);
    const port = proxy.port;
    await proxy.close();
    await expect(get(port)).rejects.toBeTruthy(); // refused after unexpose
    await o.stop();
  });

  it("rejects when the listen bind fails (honest error, no false success)", async () => {
    const taken = await tcpProxy("127.0.0.1", 0, "127.0.0.1", 1); // hold a port
    await expect(tcpProxy("127.0.0.1", taken.port, "127.0.0.1", 1)).rejects.toBeTruthy(); // same port → EADDRINUSE
    await taken.close();
  });
});
