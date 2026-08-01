// channel-app / architecture §7: the gateway trusts Tonoman Cloud's SIGNATURE, nothing else.
// These tests pin the properties that make it safe to expose an agent API publicly — every
// one of them is a way a JWT verifier is classically broken.

import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { JwksVerifier } from "./cloudauth";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";

function jwks(): { keys: unknown[] } {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] };
}

/** A fetch stub that serves the key set and counts how often it was asked. */
function stubFetch(body: unknown = jwks()): typeof fetch & { calls: number } {
  const f = (async () => {
    f.calls++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch & { calls: number };
  f.calls = 0;
  return f;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(claims: Record<string, unknown>, opts?: { kid?: string; alg?: string; key?: crypto.KeyObject }): string {
  const header = { alg: opts?.alg ?? "RS256", typ: "JWT", kid: opts?.kid ?? KID };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign("sha256", Buffer.from(input), {
    key: opts?.key ?? privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${input}.${b64url(sig)}`;
}

const soon = () => Math.floor(Date.now() / 1000) + 300;

function verifier(fetchImpl: typeof fetch, over?: Partial<{ issuer: string; audience: string }>) {
  return new JwksVerifier({
    jwksUrl: "https://cloud.test/api/.well-known/jwks.json",
    issuer: "https://cloud.test",
    audience: "gw-sapien",
    fetchImpl,
    ...over,
  });
}

describe("JwksVerifier — the gateway's only trust anchor (channel-app)", () => {
  it("accepts a well-formed token and surfaces the verified email", async () => {
    const c = await verifier(stubFetch()).verify(
      sign({ sub: "u1", email: "rod@rodnavarro.com", name: "Rod", iss: "https://cloud.test", aud: "gw-sapien", exp: soon() }),
    );
    expect(c.sub).toBe("u1");
    // The email is what the connector promotes to a VERIFIED identity, so the agent may
    // treat it as fact — unlike a Telegram display name.
    expect(c.email).toBe("rod@rodnavarro.com");
  });

  it("rejects a token minted for ANOTHER gateway — the scoping is the whole point", async () => {
    // Without this, a token for someone's laptop gateway would unlock a cloud-hosted one.
    await expect(
      verifier(stubFetch()).verify(sign({ sub: "u1", iss: "https://cloud.test", aud: "gw-someone-else", exp: soon() })),
    ).rejects.toThrow(/audience/);
  });

  it("rejects an expired token", async () => {
    await expect(
      verifier(stubFetch()).verify(
        sign({ sub: "u1", iss: "https://cloud.test", aud: "gw-sapien", exp: Math.floor(Date.now() / 1000) - 3600 }),
      ),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a token signed by a DIFFERENT key (forgery)", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      verifier(stubFetch()).verify(
        sign({ sub: "u1", iss: "https://cloud.test", aud: "gw-sapien", exp: soon() }, { key: other.privateKey }),
      ),
    ).rejects.toThrow(/signature/);
  });

  it('rejects alg "none" and HS256 — alg confusion is allow-listed out, not blocked case by case', async () => {
    for (const alg of ["none", "HS256", "RS512"]) {
      await expect(
        verifier(stubFetch()).verify(sign({ sub: "u1", iss: "https://cloud.test", aud: "gw-sapien", exp: soon() }, { alg })),
      ).rejects.toThrow(/unsupported alg/);
    }
  });

  it("rejects a wrong issuer", async () => {
    await expect(
      verifier(stubFetch()).verify(sign({ sub: "u1", iss: "https://evil.test", aud: "gw-sapien", exp: soon() })),
    ).rejects.toThrow(/issuer/);
  });

  it("rejects a token with no subject", async () => {
    await expect(
      verifier(stubFetch()).verify(sign({ iss: "https://cloud.test", aud: "gw-sapien", exp: soon() })),
    ).rejects.toThrow(/subject/);
  });

  it("caches the key set — a junk-kid flood cannot amplify into a JWKS fetch storm", async () => {
    const f = stubFetch();
    const v = verifier(f);
    await v.verify(sign({ sub: "u1", iss: "https://cloud.test", aud: "gw-sapien", exp: soon() }));
    expect(f.calls).toBe(1);
    for (let i = 0; i < 20; i++) {
      await v.verify(sign({ sub: "u1", iss: "https://cloud.test", aud: "gw-sapien", exp: soon() }, { kid: `junk-${i}` })).catch(
        () => {},
      );
    }
    // MIN_REFETCH_MS holds it at the one warm fetch, rather than one per unknown kid.
    expect(f.calls).toBe(1);
  });

  it("rejects a malformed token without throwing something unhelpful", async () => {
    for (const bad of ["", "a.b", "not-a-jwt", "a.b.c"]) {
      await expect(verifier(stubFetch()).verify(bad)).rejects.toThrow();
    }
  });
});
