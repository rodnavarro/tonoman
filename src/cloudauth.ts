// Verifies the short-lived, gateway-scoped bearer tokens Tonoman Cloud mints for a client
// (channel-app / docs/architecture.md §7).
//
// The point of this module is what the gateway does NOT have to hold. A client is signed in
// to the cloud (Zitadel → Google); the cloud checks the caller's membership and mints a JWT
// scoped to ONE gateway; the gateway verifies it against the cloud's PUBLIC keys. So the
// gateway needs no user database, no shared secret, and no callback to the cloud on the hot
// path — and a self-hosted gateway on someone's laptop is safe to expose without trusting
// it with anything revocable-by-theft.
//
// Zero runtime dependencies: node:crypto imports a JWK directly and verifies RS256/ES256.
// This is deliberately a VERIFIER only — nothing here mints tokens.

import * as crypto from "node:crypto";

/** The subset of claims the gateway acts on. */
export interface VerifiedClaims {
  sub: string;
  email?: string;
  name?: string;
  /** the gateway id this token is scoped to. */
  aud?: string | string[];
  iss?: string;
  exp: number;
  [k: string]: unknown;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedClaims>;
}

/** Tolerated clock skew between the cloud and the gateway host. */
const SKEW_S = 60;
/** Re-fetch the key set no more often than this, even on an unknown `kid` — otherwise a
 * stream of junk tokens with random kids becomes a JWKS-fetch amplifier against the cloud. */
const MIN_REFETCH_MS = 60_000;
/** Refresh keys on this cadence regardless, so a rotated key is picked up before a token
 * signed with it arrives. */
const MAX_KEY_AGE_MS = 10 * 60_000;

export interface JwksVerifierOptions {
  /** the cloud's key set, e.g. https://cloud.tonoman.com/api/.well-known/jwks.json */
  jwksUrl: string;
  /** required `iss`. Omit only in tests. */
  issuer?: string;
  /** required `aud` — the gateway id. A token minted for another gateway MUST NOT work here. */
  audience?: string;
  fetchImpl?: typeof fetch;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

export class JwksVerifier implements TokenVerifier {
  private keys = new Map<string, crypto.KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly o: JwksVerifierOptions) {}

  async verify(token: string): Promise<VerifiedClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed jwt");
    const [h64, p64, s64] = parts;

    const header = decodeJson(h64) as { alg?: string; kid?: string; typ?: string };
    const alg = header.alg;
    if (alg !== "RS256" && alg !== "ES256") throw new Error(`unsupported alg ${alg}`);
    // `none` and symmetric algs are rejected above by allow-listing, not by blocking a
    // deny-list — the classic JWT confusion bug is an alg we forgot to exclude.

    const key = await this.keyFor(header.kid);
    const signingInput = Buffer.from(`${h64}.${p64}`, "utf8");
    const sig = Buffer.from(b64urlToB64(s64), "base64");

    const ok =
      alg === "RS256"
        ? crypto.verify("sha256", signingInput, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig)
        : crypto.verify("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, sig);
    if (!ok) throw new Error("bad signature");

    const claims = decodeJson(p64) as VerifiedClaims;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new Error("expired");
    if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) throw new Error("not yet valid");
    if (this.o.issuer && claims.iss !== this.o.issuer) throw new Error("wrong issuer");
    if (this.o.audience) {
      const aud = claims.aud;
      const list = Array.isArray(aud) ? aud : aud ? [aud] : [];
      if (!list.includes(this.o.audience)) throw new Error("wrong audience");
    }
    if (!claims.sub) throw new Error("no subject");
    return claims;
  }

  /** Returns the key for `kid`, refreshing the set at most once per MIN_REFETCH_MS. */
  private async keyFor(kid?: string): Promise<crypto.KeyObject> {
    const stale = Date.now() - this.fetchedAt > MAX_KEY_AGE_MS;
    if (this.keys.size === 0 || stale || (kid && !this.keys.has(kid))) {
      if (Date.now() - this.fetchedAt > MIN_REFETCH_MS || this.keys.size === 0) await this.refresh();
    }
    if (kid) {
      const k = this.keys.get(kid);
      if (!k) throw new Error(`unknown key ${kid}`);
      return k;
    }
    // No kid: only unambiguous when the set holds exactly one key.
    if (this.keys.size !== 1) throw new Error("token has no kid and the key set is ambiguous");
    return [...this.keys.values()][0];
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const f = this.o.fetchImpl ?? fetch;
    this.inflight = (async () => {
      const resp = await f(this.o.jwksUrl, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`jwks fetch ${resp.status}`);
      const body = (await resp.json()) as { keys?: Jwk[] };
      const next = new Map<string, crypto.KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (jwk.use && jwk.use !== "sig") continue;
        try {
          next.set(String(jwk.kid ?? ""), crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" }));
        } catch {
          // A key we can't import (unsupported curve, malformed) must not poison the rest.
        }
      }
      if (next.size === 0) throw new Error("jwks contained no usable keys");
      this.keys = next;
      this.fetchedAt = Date.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}

/** Accepts every token. ONLY for local development — never construct this from config
 * that a deployment can reach. */
export class InsecureVerifier implements TokenVerifier {
  async verify(): Promise<VerifiedClaims> {
    return { sub: "dev", email: "dev@localhost", name: "dev", exp: Math.floor(Date.now() / 1000) + 3600 };
  }
}

function b64urlToB64(s: string): string {
  return s.replace(/-/g, "+").replace(/_/g, "/");
}

function decodeJson(seg: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(b64urlToB64(seg), "base64").toString("utf8"));
  } catch {
    throw new Error("malformed jwt segment");
  }
}
