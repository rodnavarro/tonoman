// `tonoman web fetch` — one public web page, opened FROM THE WORKER the way a browser asks for it
// (TOOL-WEB-FETCH in Tonoman Cloud). It exists because a provider's own web search fetches from the
// provider's servers, which some sites refuse; from here they answer as they would a person.
//
// The danger of fetching from the worker is the worker's network: a page that talks an agent into
// fetching `http://temporal…:7233` or a cloud metadata address would reach things no person outside
// can. So the address is checked AT CONNECT TIME, on the address actually connected to — a public
// name that resolves inside is refused, and so is every redirect that leads inside.

import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";

/** PURE: may the worker connect to this address? Public unicast only. */
export function publicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT (and Tailscale)
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 192 && b === 0) return false; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return publicAddress(mapped[1]!);
    const first = parseInt(s.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    return true;
  }
  return false;
}

/** A `lookup` that resolves as usual and refuses any address that is not public, so the check is on
 *  the very address the socket then connects to (no window between checking and connecting). */
export function guardedLookup(allow: (ip: string) => boolean = publicAddress, resolve: typeof dns.lookup = dns.lookup): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = (addresses as dns.LookupAddress[]).filter((a) => allow(a.address));
      if (!list.length) {
        const e = new Error(`${hostname} is not on the public internet`) as NodeJS.ErrnoException;
        e.code = "ENOTPUBLIC";
        return callback(e, "", 0);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  }) as LookupFunction;
}

export interface Page {
  url: string;
  status: number;
  title: string;
  description: string;
  text: string;
}

const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9,es;q=0.8",
};
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;

/** PURE: the entities a page's text is full of. */
function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** PURE: a page's title, description and readable text. */
export function readable(html: string): { title: string; description: string; text: string } {
  const meta = (name: string) =>
    decode(
      (new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i").exec(html) ??
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, "i").exec(html))?.[1] ?? "",
    ).trim();
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim() || meta("og:title");
  const description = meta("description") || meta("og:description");
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, description, text };
}

export interface FetchOptions {
  /** Which addresses may be connected to. Public only, unless a test says otherwise. */
  allow?: (ip: string) => boolean;
  resolve?: typeof dns.lookup;
  timeoutMs?: number;
  /** Accept `http:` too (tests only; a person's page is fetched over https). */
  allowHttp?: boolean;
}

function get(url: URL, o: FetchOptions): Promise<{ status: number; location?: string; type: string; body: string }> {
  const lib = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      { method: "GET", headers: BROWSER_HEADERS, lookup: guardedLookup(o.allow, o.resolve), timeout: o.timeoutMs ?? 20_000 },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, type: "", body: "" });
        }
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => {
          n += c.length;
          if (n > MAX_BYTES) {
            req.destroy();
            return resolve({ status, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") });
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("the page took too long to answer")));
    req.on("error", reject);
    req.end();
  });
}

/** Open one page. Throws, in words a person can follow, when it cannot or may not. */
export async function fetchPage(address: string, o: FetchOptions = {}): Promise<Page> {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error("that is not a web address");
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" && !(o.allowHttp && url.protocol === "http:")) throw new Error("only https addresses can be opened");
    if (url.username || url.password) throw new Error("an address with a login in it cannot be opened");
    // A literal address is checked here; a name is checked as it resolves (guardedLookup).
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !(o.allow ?? publicAddress)(host)) throw new Error(`${host} is not on the public internet`);
    let r;
    try {
      r = await get(url, o);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new Error(err.code === "ENOTPUBLIC" ? err.message : `the page could not be opened (${err.message})`);
    }
    if (r.location) {
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      url = new URL(r.location, url);
      continue;
    }
    if (r.status >= 400) {
      throw new Error(r.status === 999 || r.status === 403 || r.status === 429 ? `the site refused (HTTP ${r.status})` : `the site answered HTTP ${r.status}`);
    }
    const isHtml = /html|xml/i.test(r.type) || /^\s*</.test(r.body);
    const page = isHtml ? readable(r.body) : { title: "", description: "", text: r.body };
    return { url: url.toString(), status: r.status, ...page };
  }
}
