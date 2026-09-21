// Signing in to LOREALISTAR the way its own page does (docs/definition/objects/drop-watch.md in
// Tonoman Cloud). The test plays the sign-in service's half of the handshake — the half that only
// knows a verifier, never the password — so the client's proof has to be one a real service accepts.
import { describe, it, expect } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { N_HEX, G_HEX } from "./group";
import { padHex, srpStart, srpProof, cognitoTimestamp, signIn, renew, type CognitoCall } from "./srp";

const N = BigInt(`0x${N_HEX}`);
const g = BigInt(`0x${G_HEX}`);
const hexHash = (hex: string) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex").padStart(64, "0");
const hash = (s: string) => createHash("sha256").update(s).digest("hex").padStart(64, "0");
const modPow = (b: bigint, e: bigint, m: bigint) => {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
};

/** The service's side: it holds a salt and a verifier made from the password once, long ago. */
function service(pool: string, userId: string, password: string) {
  const salt = randomBytes(16).toString("hex");
  const x = BigInt(`0x${hexHash(padHex(salt) + hash(`${pool}${userId}:${password}`))}`);
  const v = modPow(g, x, N);
  const k = BigInt(`0x${hexHash(padHex(N_HEX) + padHex(G_HEX))}`);
  const b = BigInt(`0x${randomBytes(128).toString("hex")}`) % N;
  const B = (k * v + modPow(g, b, N)) % N;
  const secretBlock = randomBytes(32).toString("base64");
  return {
    challenge: { SALT: salt, SRP_B: B.toString(16), SECRET_BLOCK: secretBlock, USER_ID_FOR_SRP: userId },
    /** Would the service accept this proof? */
    accepts(A_hex: string, timestamp: string, signature: string): boolean {
      const A = BigInt(`0x${A_hex}`);
      const u = BigInt(`0x${hexHash(padHex(A_hex) + padHex(B.toString(16)))}`);
      const S = modPow((A * modPow(v, u, N)) % N, b, N);
      const prk = createHmac("sha256", Buffer.from(padHex(u.toString(16)), "hex")).update(Buffer.from(padHex(S.toString(16)), "hex")).digest();
      const key = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("Caldera Derived Key", "utf8"), Buffer.from([1])])).digest().subarray(0, 16);
      const expected = createHmac("sha256", key)
        .update(Buffer.concat([Buffer.from(pool, "utf8"), Buffer.from(userId, "utf8"), Buffer.from(secretBlock, "base64"), Buffer.from(timestamp, "utf8")]))
        .digest("base64");
      return expected === signature;
    },
  };
}

describe("the handshake", () => {
  it("DROPS-NO-BROWSER the proof the client gives is one the sign-in service accepts, for the right password", () => {
    const svc = service("wDTwPouSP", "b1f2-user-id", "correct horse battery staple");
    const start = srpStart();
    const proof = srpProof({ poolName: "wDTwPouSP", password: "correct horse battery staple", a: start.a, A: start.A, challenge: svc.challenge, now: new Date("2026-09-20T04:11:12Z") });
    expect(proof.timestamp).toBe("Sun Sep 20 04:11:12 UTC 2026");
    expect(svc.accepts(start.A, proof.timestamp, proof.signature)).toBe(true);
  });

  it("DROPS-NO-BROWSER …and for the wrong password it is not", () => {
    const svc = service("wDTwPouSP", "b1f2-user-id", "correct horse battery staple");
    const start = srpStart();
    const proof = srpProof({ poolName: "wDTwPouSP", password: "a guess", a: start.a, A: start.A, challenge: svc.challenge, now: new Date() });
    expect(svc.accepts(start.A, proof.timestamp, proof.signature)).toBe(false);
  });

  it("DROPS-NO-BROWSER many times over, whatever the random numbers: a proof that fails one time in fifty is a login that fails one morning in fifty", () => {
    for (let i = 0; i < 40; i++) {
      const svc = service("wDTwPouSP", `user-${i}`, `pässwörd-${i}`);
      const start = srpStart();
      const proof = srpProof({ poolName: "wDTwPouSP", password: `pässwörd-${i}`, a: start.a, A: start.A, challenge: svc.challenge, now: new Date() });
      expect(svc.accepts(start.A, proof.timestamp, proof.signature)).toBe(true);
    }
  });

  it("DROPS-NO-BROWSER the day of the month is written as the service expects it: no leading zero", () => {
    expect(cognitoTimestamp(new Date("2026-03-05T09:07:03Z"))).toBe("Thu Mar 5 09:07:03 UTC 2026");
  });

  it("DROPS-NO-BROWSER a number is padded as the service pads it", () => {
    expect(padHex("abc")).toBe("0abc");
    expect(padHex("7f")).toBe("7f");
    expect(padHex("80")).toBe("0080");
    expect(padHex("ff00")).toBe("00ff00");
  });
});

describe("signing in, and keeping the session", () => {
  /** A sign-in service that speaks the two calls, and counts them. */
  const fake = (password: string, o: { challenge?: string } = {}) => {
    const calls: string[] = [];
    let svc: ReturnType<typeof service> | undefined;
    let A = "";
    const call: CognitoCall = async (target, body) => {
      calls.push(target);
      const b = body as { AuthFlow?: string; AuthParameters?: Record<string, string>; ChallengeResponses?: Record<string, string> };
      if (target === "InitiateAuth" && b.AuthFlow === "USER_SRP_AUTH") {
        svc = service("wDTwPouSP", "the-user-id", password);
        A = b.AuthParameters!.SRP_A!;
        return { status: 200, json: { ChallengeName: "PASSWORD_VERIFIER", ChallengeParameters: svc.challenge } };
      }
      if (target === "RespondToAuthChallenge") {
        const r = b.ChallengeResponses!;
        if (!svc!.accepts(A, r.TIMESTAMP!, r.PASSWORD_CLAIM_SIGNATURE!)) return { status: 400, json: { __type: "NotAuthorizedException", message: "Incorrect username or password." } };
        if (o.challenge) return { status: 200, json: { ChallengeName: o.challenge, ChallengeParameters: {} } };
        return { status: 200, json: { AuthenticationResult: { AccessToken: "access-1", RefreshToken: "refresh-1", ExpiresIn: 3600 } } };
      }
      if (target === "InitiateAuth" && b.AuthFlow === "REFRESH_TOKEN_AUTH") {
        if (b.AuthParameters!.REFRESH_TOKEN !== "refresh-1") return { status: 400, json: { __type: "NotAuthorizedException", message: "Refresh Token has expired" } };
        return { status: 200, json: { AuthenticationResult: { AccessToken: "access-2", ExpiresIn: 3600 } } };
      }
      return { status: 400, json: { __type: "Unexpected" } };
    };
    return { call, calls };
  };
  const pool = { userPoolId: "us-east-1_wDTwPouSP", clientId: "5uau3lmnl89k9paakt8bjurb2a" };

  it("DROPS-NO-BROWSER an email and a password become a session, in the two calls the site's own page makes", async () => {
    const f = fake("s3cret!");
    const r = await signIn(pool, "test+ana@tonoman.com", "s3cret!", f.call);
    expect(r).toMatchObject({ ok: true, session: { accessToken: "access-1", refreshToken: "refresh-1" } });
    expect(f.calls).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
  });

  it("DROPS-LOGIN-PROVED-FIRST a wrong password is refused with the site's own reason, and says the person must put it right", async () => {
    const r = await signIn(pool, "test+ana@tonoman.com", "not it", fake("s3cret!").call);
    expect(r).toMatchObject({ ok: false, needsPerson: true });
    expect(r.ok ? "" : r.why).toMatch(/Incorrect username or password/);
  });

  it("DROPS-SAYS-WHY-IT-STOPPED when the site asks for a code, or anything else a program cannot give, that is said — never treated as a sign-in", async () => {
    const r = await signIn(pool, "test+ana@tonoman.com", "s3cret!", fake("s3cret!", { challenge: "SMS_MFA" }).call);
    expect(r).toMatchObject({ ok: false, needsPerson: true });
    expect(r.ok ? "" : r.why).toMatch(/code/i);
  });

  it("DROPS-KEEPS-ITS-SESSION a session is renewed with what the site gave, without the password", async () => {
    const f = fake("s3cret!");
    const r = await renew(pool, "refresh-1", f.call);
    expect(r).toMatchObject({ ok: true, session: { accessToken: "access-2", refreshToken: "refresh-1" } });
    expect(f.calls).toEqual(["InitiateAuth"]);
  });

  it("DROPS-KEEPS-ITS-SESSION one that can no longer be renewed says so, so the password is used again — once", async () => {
    const r = await renew(pool, "stale", fake("s3cret!").call);
    expect(r).toMatchObject({ ok: false, expired: true });
  });

  it("DROPS-A-BAD-LOOK-IS-NOT-THE-END the sign-in service being down is a passing reason, not the person's to fix", async () => {
    const down: CognitoCall = async () => ({ status: 503, json: {} });
    const r = await signIn(pool, "test+ana@tonoman.com", "s3cret!", down);
    expect(r).toMatchObject({ ok: false, needsPerson: false });
  });
});
