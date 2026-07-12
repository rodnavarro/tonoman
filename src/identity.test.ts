import { describe, it, expect } from "vitest";
import { parseRoster, resolveIdentity, refusalNotice, Roster } from "./identity";

const ROSTER_JSON = JSON.stringify({
  people: [
    { name: "Dana Whitfield", role: "Owner / CPA", emails: ["dana@northgate.example", "d.whitfield@northgate.example"] },
    { name: "Priya Raman", role: "billing reviewer — the approver", emails: ["priya@northgate.example"] },
    { name: "Dede Smith", role: "General Manager", emails: [] },
    { name: "Rod", role: "operator", emails: ["rod@example.com"] },
    { name: "Rod2", role: "operator (second identity)", emails: ["rod2@example.com"] },
  ],
});

describe("identity roster (identity-roster)", () => {
  it("identity-roster-load: parses the mounted JSON into a roster", () => {
    const r = parseRoster(ROSTER_JSON);
    expect(r.size).toBe(5);
  });

  it("identity-roster-match: a known email resolves to that person + role, verified", () => {
    const r = parseRoster(ROSTER_JSON);
    const id = resolveIdentity(r, "priya@northgate.example", "Some Display Name");
    expect(id).toMatchObject({ name: "Priya Raman", role: "billing reviewer — the approver", verified: true });
  });

  it("identity-roster-match: matching is case-insensitive and ignores surrounding space", () => {
    const r = parseRoster(ROSTER_JSON);
    expect(resolveIdentity(r, "  PRIYA@Northgate.example  ", "x").name).toBe("Priya Raman");
  });

  it("identity-roster-multi-email: EITHER of Dana's addresses resolves to Dana", () => {
    const r = parseRoster(ROSTER_JSON);
    expect(resolveIdentity(r, "dana@northgate.example", "x").name).toBe("Dana Whitfield");
    expect(resolveIdentity(r, "d.whitfield@northgate.example", "x").name).toBe("Dana Whitfield");
  });

  it("identity-roster-distinct: two different emails resolve to two DIFFERENT people", () => {
    const r = parseRoster(ROSTER_JSON);
    const a = resolveIdentity(r, "rod@example.com", "Rod");
    const b = resolveIdentity(r, "rod2@example.com", "Rod");
    expect(a.name).toBe("Rod");
    expect(b.name).toBe("Rod2");
    expect(a.name).not.toBe(b.name); // same human, distinct identities — keyed on email
  });

  it("identity-roster-unknown: an unlisted email is unverified with no role", () => {
    const r = parseRoster(ROSTER_JSON);
    const id = resolveIdentity(r, "stranger@example.com", "Priya Raman"); // spoofed display name
    expect(id.verified).toBe(false);
    expect(id.role).toBeUndefined();
    expect(id.name).toBe("Priya Raman"); // preserved but NOT trusted (verified=false)
  });

  it("identity-roster-unknown: an entry with no emails (Dede) never matches", () => {
    const r = parseRoster(ROSTER_JSON);
    expect(resolveIdentity(r, "", "Dede Smith").verified).toBe(false);
  });

  it("identity-email-nonfatal: no email or no roster → unverified, never throws", () => {
    expect(resolveIdentity(parseRoster(ROSTER_JSON), undefined, "Nobody").verified).toBe(false);
    expect(resolveIdentity(undefined, "priya@northgate.example", "x").verified).toBe(false);
  });

  it("identity-roster-load: a malformed roster yields an EMPTY roster, not a crash", () => {
    expect(parseRoster("}{ not json").size).toBe(0);
    expect(parseRoster(JSON.stringify({ nope: 1 })).size).toBe(0);
    expect(new Roster([]).match("a@b.com")).toBeNull();
  });

  it("identity-roster-restrict: the refusal is deterministic and names the address", () => {
    expect(refusalNotice("stranger@example.com")).toContain("'stranger@example.com'");
    expect(refusalNotice("stranger@example.com")).toContain("not authorized");
    expect(refusalNotice("guest_x#EXT#@t.onmicrosoft.com")).toContain("guest_x#EXT#@t.onmicrosoft.com"); // UPN echoed for the whitelist loop
    expect(refusalNotice(undefined)).toContain("couldn't determine");
  });
});
