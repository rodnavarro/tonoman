// Signing in to a Cognito user pool the way a site's own page does: the SRP handshake, in which the
// password never leaves this process and the service only ever sees a proof of it. Two calls — no
// browser (DROPS-NO-BROWSER in Tonoman Cloud's docs/definition/objects/drop-watch.md).
//
// The plain "here is my password" flow is switched off for LOREALISTAR's app, as it is for most
// sites built on Amplify, so this is the only door. The arithmetic follows Amazon's own client
// (amazon-cognito-identity-js) step for step; srp.test.ts plays the service's half and checks the
// proof is one a service accepts.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { N_HEX, G_HEX } from "./group";

export interface Pool {
  /** e.g. `us-east-1_wDTwPouSP`: the region, and the pool's name after the underscore. */
  userPoolId: string;
  clientId: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working (ms since the epoch). */
  expiresAt: number;
}

export type SignIn =
  | { ok: true; session: Session }
  /** `needsPerson`: the site refused the login, or asks for something a program cannot give — the
   *  person has to put it right, and trying again would only knock on their account. Otherwise it is
   *  a passing reason: the service was down, or slow. */
  | { ok: false; needsPerson: boolean; why: string };

export type Renewal = { ok: true; session: Session } | { ok: false; expired: boolean; why: string };

/** One call to the sign-in service. Injected so a test can play the service. */
export type CognitoCall = (target: string, body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;

const N = BigInt(`0x${N_HEX}`);
const g = BigInt(`0x${G_HEX}`);

/** PURE: a number as the service pads it — an even count of digits, and a leading 00 when the first
 *  digit would make it read as negative. */
export function padHex(hex: string): string {
  const even = hex.length % 2 ? `0${hex}` : hex;
  return /^[89a-fA-F]/.test(even) ? `00${even}` : even;
}

const hashHex = (hex: string): string => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex").padStart(64, "0");
const hashText = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").padStart(64, "0");

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

/** The client's secret number for one sign-in, and the public one it sends. */
export function srpStart(): { a: bigint; A: string } {
  for (;;) {
    const a = BigInt(`0x${randomBytes(128).toString("hex")}`) % N;
    const A = modPow(g, a, N);
    if (A % N !== 0n) return { a, A: A.toString(16) };
  }
}

/** PURE: the time as the service expects to be told it — `Sun Sep 20 04:11:12 UTC 2026`, the day of
 *  the month with no leading zero. */
export function cognitoTimestamp(now: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${now.getUTCDate()} ${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())} UTC ${now.getUTCFullYear()}`;
}

/** PURE: the proof of the password, for the challenge the service sent. */
export function srpProof(o: {
  poolName: string;
  password: string;
  a: bigint;
  A: string;
  challenge: { SALT: string; SRP_B: string; SECRET_BLOCK: string; USER_ID_FOR_SRP: string };
  now: Date;
}): { timestamp: string; signature: string } {
  const B = BigInt(`0x${o.challenge.SRP_B}`);
  if (B % N === 0n) throw new Error("the sign-in service sent a number no honest service sends");
  const k = BigInt(`0x${hashHex(padHex(N_HEX) + padHex(G_HEX))}`);
  const u = BigInt(`0x${hashHex(padHex(o.A) + padHex(o.challenge.SRP_B))}`);
  if (u === 0n) throw new Error("the sign-in handshake could not be completed");
  const x = BigInt(`0x${hashHex(padHex(o.challenge.SALT) + hashText(`${o.poolName}${o.challenge.USER_ID_FOR_SRP}:${o.password}`))}`);
  const S = modPow(B - ((k * modPow(g, x, N)) % N), o.a + u * x, N);
  const prk = createHmac("sha256", Buffer.from(padHex(u.toString(16)), "hex")).update(Buffer.from(padHex(S.toString(16)), "hex")).digest();
  const key = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("Caldera Derived Key", "utf8"), Buffer.from([1])])).digest().subarray(0, 16);
  const timestamp = cognitoTimestamp(o.now);
  const signature = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(o.poolName, "utf8"), Buffer.from(o.challenge.USER_ID_FOR_SRP, "utf8"), Buffer.from(o.challenge.SECRET_BLOCK, "base64"), Buffer.from(timestamp, "utf8")]))
    .digest("base64");
  return { timestamp, signature };
}

/** The real sign-in service for a pool's region. Never logs what it sends or is sent. */
export function cognitoOver(region: string, fetchImpl: typeof fetch = fetch): CognitoCall {
  return async (target, body) => {
    const r = await fetchImpl(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${target}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: r.status, json: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const sessionOf = (result: Record<string, unknown>, refreshToken: string, now: number): Session => ({
  accessToken: str(result.AccessToken),
  refreshToken: str(result.RefreshToken) || refreshToken,
  expiresAt: now + Math.max(60, Number(result.ExpiresIn) || 3600) * 1000,
});

/** What the service calls a refusal of the login itself — the person's to put right. */
const REFUSED = /NotAuthorized|UserNotFound|UserNotConfirmed|PasswordResetRequired|InvalidParameter|InvalidPassword/;

/** Sign in with an email and a password. */
export async function signIn(pool: Pool, email: string, password: string, call: CognitoCall = cognitoOver(pool.userPoolId.split("_")[0]!), now: () => Date = () => new Date()): Promise<SignIn> {
  const poolName = pool.userPoolId.split("_")[1] ?? "";
  try {
    const { a, A } = srpStart();
    const first = await call("InitiateAuth", { AuthFlow: "USER_SRP_AUTH", ClientId: pool.clientId, AuthParameters: { USERNAME: email, SRP_A: A } });
    if (first.status !== 200) return refusal(first);
    if (str(first.json.ChallengeName) !== "PASSWORD_VERIFIER") return asksForMore(str(first.json.ChallengeName));
    const c = (first.json.ChallengeParameters ?? {}) as Record<string, string>;
    const proof = srpProof({ poolName, password, a, A, challenge: { SALT: str(c.SALT), SRP_B: str(c.SRP_B), SECRET_BLOCK: str(c.SECRET_BLOCK), USER_ID_FOR_SRP: str(c.USER_ID_FOR_SRP) }, now: now() });
    const second = await call("RespondToAuthChallenge", {
      ChallengeName: "PASSWORD_VERIFIER",
      ClientId: pool.clientId,
      ChallengeResponses: { USERNAME: str(c.USER_ID_FOR_SRP) || email, PASSWORD_CLAIM_SECRET_BLOCK: str(c.SECRET_BLOCK), TIMESTAMP: proof.timestamp, PASSWORD_CLAIM_SIGNATURE: proof.signature },
    });
    if (second.status !== 200) return refusal(second);
    if (second.json.ChallengeName) return asksForMore(str(second.json.ChallengeName));
    const result = (second.json.AuthenticationResult ?? {}) as Record<string, unknown>;
    if (!str(result.AccessToken) || !str(result.RefreshToken)) return { ok: false, needsPerson: false, why: "the sign-in service answered without a session" };
    return { ok: true, session: sessionOf(result, "", now().getTime()) };
  } catch (e) {
    return { ok: false, needsPerson: false, why: `the sign-in service could not be reached (${(e as Error).message.slice(0, 80)})` };
  }
}

function refusal(r: { status: number; json: Record<string, unknown> }): SignIn {
  const type = str(r.json.__type).split("#").pop() ?? "";
  const message = str(r.json.message) || type || `HTTP ${r.status}`;
  // The service's own words, which name no secret: "Incorrect username or password."
  return { ok: false, needsPerson: REFUSED.test(type), why: message.slice(0, 160) };
}

function asksForMore(challenge: string): SignIn {
  const what = /MFA|SOFTWARE_TOKEN|SMS|EMAIL_OTP/.test(challenge) ? "a code sent to the person" : /NEW_PASSWORD/.test(challenge) ? "a new password" : `something more (${challenge || "unknown"})`;
  return { ok: false, needsPerson: true, why: `the site asks for ${what}, which only the person can give` };
}

/** Renew a session with what the site gave when it was made. No password. */
export async function renew(pool: Pool, refreshToken: string, call: CognitoCall = cognitoOver(pool.userPoolId.split("_")[0]!), now: () => Date = () => new Date()): Promise<Renewal> {
  try {
    const r = await call("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: pool.clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } });
    if (r.status !== 200) {
      const type = str(r.json.__type).split("#").pop() ?? "";
      return { ok: false, expired: REFUSED.test(type), why: (str(r.json.message) || type || `HTTP ${r.status}`).slice(0, 160) };
    }
    const result = (r.json.AuthenticationResult ?? {}) as Record<string, unknown>;
    if (!str(result.AccessToken)) return { ok: false, expired: false, why: "the sign-in service answered without a session" };
    return { ok: true, session: sessionOf(result, refreshToken, now().getTime()) };
  } catch (e) {
    return { ok: false, expired: false, why: `the sign-in service could not be reached (${(e as Error).message.slice(0, 80)})` };
  }
}
