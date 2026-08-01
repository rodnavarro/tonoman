// OIDC Authorization Code + PKCE against Zitadel.
//
// Hand-rolled rather than pulled from a library: PKCE is ~80 lines, and this way there is
// no dependency between us and how a library chooses to store tokens.
//
// This is a PUBLIC client — no secret ships to the browser, which is why PKCE exists. The
// access token we get back is what the Cloud API verifies; the Cloud API then mints the
// separate, gateway-scoped token used to talk to a gateway directly.

const STORE_KEY = "tonoman.session";
const VERIFIER_KEY = "tonoman.pkce";

export interface Session {
  accessToken: string;
  idToken?: string;
  expiresAt: number;
  refreshToken?: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

/** Config is served by the API so the client is built once and deployed anywhere — no
 * rebuild to point at a different Zitadel. */
export async function loadConfig(): Promise<OidcConfig> {
  const r = await fetch("/api/config");
  if (!r.ok) throw new Error("could not load auth config");
  return r.json();
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Sends the browser to Zitadel. The verifier stays in sessionStorage so the code that
 * comes back can only be redeemed by this tab. */
export async function login(cfg: OidcConfig): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await sha256(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));

  const u = new URL(`${cfg.issuer}/oauth/v2/authorize`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scope);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  window.location.assign(u.toString());
}

/** Completes the redirect. Returns null when this isn't a callback. */
export async function completeLogin(cfg: OidcConfig): Promise<Session | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return null;

  const stashed = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!stashed) throw new Error("no PKCE verifier — start the login again");
  const { verifier, state } = JSON.parse(stashed) as { verifier: string; state: string };
  // A mismatched state means this redirect was not initiated by us (CSRF).
  if (params.get("state") !== state) throw new Error("state mismatch");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  const r = await fetch(`${cfg.issuer}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  const t = (await r.json()) as { access_token: string; id_token?: string; expires_in: number; refresh_token?: string };

  const session: Session = {
    accessToken: t.access_token,
    idToken: t.id_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  save(session);
  // Strip the code from the URL so a refresh doesn't try to redeem it twice.
  window.history.replaceState({}, "", window.location.pathname);
  return session;
}

export function save(s: Session): void {
  // sessionStorage, not localStorage: the token dies with the tab. On a shared or borrowed
  // phone that is the difference between a session and a standing grant.
  sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
}

export function current(): Session | null {
  const raw = sessionStorage.getItem(STORE_KEY);
  if (!raw) return null;
  const s = JSON.parse(raw) as Session;
  if (s.expiresAt < Date.now() + 30_000) return null;
  return s;
}

export function logout(): void {
  sessionStorage.removeItem(STORE_KEY);
  window.location.assign("/");
}
