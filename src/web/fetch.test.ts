// TOOL-WEB-FETCH (agent.md in Tonoman Cloud): a public page opened from the worker, and nothing that
// is not public — checked on the address actually connected to, on every redirect.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type * as dns from "node:dns";
import { fetchPage, publicAddress, readable } from "./fetch";

const servers: http.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A page on this machine. Reachable only because the test widens what is allowed to loopback. */
async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

/** Names resolve as the test says: `site.test` → loopback (where the test page is), `inside.test` →
 *  a private address. */
const resolve = ((host: string, _o: unknown, cb: (e: Error | null, a: dns.LookupAddress[]) => void) =>
  cb(null, [{ address: host === "inside.test" ? "10.1.2.3" : "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup;
const loopbackToo = (ip: string) => ip === "127.0.0.1" || publicAddress(ip);

describe("what may be opened", () => {
  it("TOOL-WEB-FETCH only public unicast addresses are public", () => {
    for (const ip of ["93.184.215.14", "8.8.8.8", "2606:4700::6810:84e5"]) expect(publicAddress(ip)).toBe(true);
    for (const ip of ["10.0.0.1", "172.16.5.4", "172.31.255.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.99.254.30", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not an ip"]) {
      expect(publicAddress(ip), ip).toBe(false);
    }
    expect(publicAddress("172.32.0.1")).toBe(true);
  });

  it("TOOL-WEB-FETCH an internal address is refused before anything is sent", async () => {
    await expect(fetchPage("https://169.254.169.254/latest/meta-data/")).rejects.toThrow("is not on the public internet");
    await expect(fetchPage("https://[::1]:7233/")).rejects.toThrow("is not on the public internet");
    await expect(fetchPage("http://example.com/")).rejects.toThrow("only https");
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow("only https");
    await expect(fetchPage("https://user:pw@example.com/")).rejects.toThrow("login in it");
  });

  it("TOOL-WEB-FETCH a public-looking name that resolves inside is refused", async () => {
    await expect(fetchPage("https://inside.test/", { resolve })).rejects.toThrow("inside.test is not on the public internet");
  });

  it("TOOL-WEB-FETCH a redirect that leads inside is refused, however the first page looked", async () => {
    const port = await serve((_q, res) => {
      res.writeHead(302, { location: "http://inside.test/secret" });
      res.end();
    });
    await expect(fetchPage(`http://site.test:${port}/`, { resolve, allow: loopbackToo, allowHttp: true })).rejects.toThrow("inside.test is not on the public internet");
  });
});

describe("what comes back", () => {
  it("TOOL-WEB-FETCH a page comes back as its title, description and text, asked for the way a browser asks", async () => {
    let agent = "";
    const port = await serve((q, res) => {
      agent = String(q.headers["user-agent"]);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><head><title>Priya Raman - Acme | Profile</title><meta property="og:description" content="Head of data &amp; AI · Location: Austin">
        <script>steal()</script><style>.x{}</style></head><body><h1>Priya Raman</h1><p>Builds data platforms.</p></body></html>`);
    });
    const p = await fetchPage(`http://site.test:${port}/in/priya`, { resolve, allow: loopbackToo, allowHttp: true });
    expect(agent).toMatch(/Mozilla\/5\.0/);
    expect(p).toMatchObject({ status: 200, title: "Priya Raman - Acme | Profile", description: "Head of data & AI · Location: Austin" });
    expect(p.text).toContain("Priya Raman\nBuilds data platforms.");
    expect(p.text).not.toContain("steal");
  });

  it("TOOL-WEB-FETCH a site that refuses is said as a refusal", async () => {
    const port = await serve((_q, res) => {
      res.writeHead(999);
      res.end();
    });
    await expect(fetchPage(`http://site.test:${port}/`, { resolve, allow: loopbackToo, allowHttp: true })).rejects.toThrow("the site refused (HTTP 999)");
  });

  it("TOOL-WEB-FETCH readable text keeps lines and drops markup", () => {
    expect(readable("<p>a&nbsp;b</p><div>c</div><!-- x -->").text).toBe("a b\nc");
  });
});
