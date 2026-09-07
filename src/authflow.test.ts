import { describe, it, expect } from "vitest";
import { extractAuthUrl, looksLoggedIn, isAuthError, authNotice, isStaleSessionError, resumeResetNotice, turnErrorNotice } from "./authflow";

// roster-auth-headless — the URL extractor is the pure, tricky bit: it must recover the
// complete OAuth URL from a real PTY transcript (ANSI escapes, cursor-column moves, 80-col
// line wrapping, and the "Paste code here" prompt concatenated onto the end).
describe("extractAuthUrl (roster-auth-headless)", () => {
  // A faithful slice of a real `script`-captured `claude auth login` transcript.
  const transcript =
    "\x1b[?25l\x1b[2G\x1b[?2004h" +
    "Browser didn't open?\x1b[23GUse the url\x1b[35Gbelow\x1b[41Gto\x1b[44Gsign\x1b[49Gin\x1b[52G(c\x1b[55Gto\x1b[58Gcopy)\r\n\r\n" +
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\r\n" +
    "ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co\r\n" +
    "m%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=FkRwIG2jpHdaTe\r\n" +
    "LJejM8iwxeRvVpgKaC6vh-_olQAgo&code_challenge_method=S256&state=uYr9QTePUc6OLkkJN1\r\n" +
    "G0Z23gfIhWkvnrb_UX1L5rhD4\r\n" +
    "\x1b[2G\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>";

  it("recovers the complete URL (un-wrapped, ANSI-stripped, prompt trimmed)", () => {
    const url = extractAuthUrl(transcript);
    expect(url).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=FkRwIG2jpHdaTeLJejM8iwxeRvVpgKaC6vh-_olQAgo&code_challenge_method=S256&state=uYr9QTePUc6OLkkJN1G0Z23gfIhWkvnrb_UX1L5rhD4",
    );
  });

  it("does NOT bleed the 'Paste code here' prompt into the state param", () => {
    expect(extractAuthUrl(transcript)).not.toContain("Paste");
  });

  it("returns undefined before the URL has appeared (spinner only)", () => {
    expect(extractAuthUrl("\x1b[?25l Opening browser to sign in… \x1b[1A✶")).toBeUndefined();
  });

  it("looksLoggedIn reads claude's auth status JSON", () => {
    expect(looksLoggedIn('{ "loggedIn": true, "email": "x@y.com" }')).toBe(true);
    expect(looksLoggedIn('{ "loggedIn": false }')).toBe(false);
  });
});

// gw-auth-actionable — an auth-shaped turn error is classified so the user gets the fix,
// not silence. Narrow enough not to fire on unrelated errors.
describe("isAuthError + authNotice (gw-auth-actionable)", () => {
  it("matches the auth-failure shapes (harness-agnostic)", () => {
    for (const m of [
      "claudecode: exit 1: Failed to authenticate. API Error: 401 Invalid authentication credentials",
      "OAuth token has expired",
      "Error: not authenticated — please run claude auth login",
      "invalid_grant",
    ])
      expect(isAuthError(m)).toBe(true);
  });

  it("does NOT fire on unrelated turn errors", () => {
    for (const m of ["claudecode: stream parse: Unexpected token", "podman: container not found", "ECONNRESET", "turn produced no result"])
      expect(isAuthError(m)).toBe(false);
  });

  it("authNotice names the agent + the exact fix command", () => {
    const n = authNotice("cardy");
    expect(n).toContain("tonoman auth login cardy --headless");
    expect(n.toLowerCase()).toContain("login");
  });
});

// gw-turn-ended-actionable — a turn NEVER dies silently: a resume of a vanished session self-heals,
// and any other failure is surfaced to the user with a short (secret-free) detail + the /new hint.
describe("isStaleSessionError + notices (gw-turn-ended-actionable)", () => {
  it("classifies resume-miss shapes (generic subtype + explicit wording)", () => {
    for (const m of [
      "claude turn failed (error_during_execution)",
      "No conversation found with session ID abc",
      "could not resume session xyz",
      "invalid session",
    ])
      expect(isStaleSessionError(m)).toBe(true);
  });

  it("does NOT fire on unrelated failures", () => {
    for (const m of ["podman: container not found", "ECONNRESET", "httpRunner: agent 500", "container not found"])
      expect(isStaleSessionError(m)).toBe(false);
  });

  it("turnErrorNotice carries a short detail + the /new hint (never silent)", () => {
    const n = turnErrorNotice("cody", "podman: container not found");
    expect(n.toLowerCase()).toContain("couldn't finish");
    expect(n).toContain("container not found");
    expect(n).toContain("/new");
  });

  it("turnErrorNotice caps the detail at 200 chars (bounded, no dumps)", () => {
    expect(turnErrorNotice("cody", "x".repeat(500))).not.toContain("x".repeat(201));
    expect(turnErrorNotice("cody", "x".repeat(500))).toContain("x".repeat(200));
  });

  it("resumeResetNotice tells the user a fresh session started", () => {
    expect(resumeResetNotice().toLowerCase()).toContain("fresh one");
  });
});
