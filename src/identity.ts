// Email-verified sender identity from a mounted roster (identity-roster). The gateway resolves a
// sender's email (via the connector) and matches it against a people roster loaded from a ConfigMap-
// mounted file — so adding an address to someone's profile is a chart edit + restart, no image
// rebuild. Recognition is keyed on EMAIL, never the spoofable Teams display name. Zero-dep, pure.

/** One person in the roster: a stable name/role and one or more addresses that identify them. */
export interface Person {
  name: string;
  role?: string;
  emails: string[];
}

/** The resolved identity attached to an envelope and rendered into the prompt. `verified` is true
 * ONLY when the sender's email matched a roster person — otherwise the sender is unknown and must
 * not be treated as an authorized/approver identity. */
export interface ResolvedIdentity {
  name: string; // roster name when verified; else the raw display name (clearly marked unverified)
  role?: string; // roster role, only when verified
  email?: string; // the resolved sender email (verified or not), when known
  verified: boolean;
}

/** An immutable email→person index. Matching is case-insensitive and by exact address; a person
 * matches if ANY of their emails matches. */
export class Roster {
  private readonly byEmail = new Map<string, Person>();
  constructor(public readonly people: Person[]) {
    for (const p of people) for (const e of p.emails) {
      const k = e.trim().toLowerCase();
      if (k) this.byEmail.set(k, p);
    }
  }
  get size(): number {
    return this.people.length;
  }
  /** The person owning `email`, or null if unknown / no email. */
  match(email?: string): Person | null {
    if (!email) return null;
    return this.byEmail.get(email.trim().toLowerCase()) ?? null;
  }
}

/** Parse roster JSON into a Roster. Tolerant: a malformed doc or missing `people` yields an EMPTY
 * roster (everyone is "unknown") rather than throwing — a bad ConfigMap must not crash the gateway. */
export function parseRoster(text: string): Roster {
  try {
    const j = JSON.parse(text) as { people?: unknown };
    const raw = Array.isArray(j.people) ? j.people : [];
    const people: Person[] = [];
    for (const r of raw) {
      const o = (r ?? {}) as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      if (!name) continue;
      const emails = Array.isArray(o.emails) ? o.emails.filter((e): e is string => typeof e === "string") : [];
      people.push({ name, role: typeof o.role === "string" ? o.role : undefined, emails });
    }
    return new Roster(people);
  } catch {
    return new Roster([]);
  }
}

/** Resolve a sender to an identity: verified (roster) when the email matches, else unverified with
 * the display name preserved so the prompt can say WHO claimed to be here without trusting it. */
export function resolveIdentity(roster: Roster | undefined, email: string | undefined, displayName: string): ResolvedIdentity {
  const person = roster?.match(email) ?? null;
  if (person) return { name: person.name, role: person.role, email, verified: true };
  return { name: displayName, email, verified: false };
}

/** The deterministic refusal shown (no LLM, no turn) when restrict_to_roster is on and a sender is
 * not authorized — names the address when known so the person knows what to get added. */
export function refusalNotice(email?: string): string {
  // Echo the EXACT resolved identifier (email or the guest `#EXT#` UPN) so the operator can copy it
  // straight into the roster ConfigMap and restart — the whitelisting loop Rod described.
  return email
    ? `Sorry — the account '${email}' is not authorized to use this assistant. To get access, send this exact ID to the administrator to add to the allow-list: ${email}`
    : `Sorry — I couldn't determine your account identity, so access is not authorized. Please contact the administrator.`;
}
