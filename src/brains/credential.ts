// Which credential a brain's repository is reached with, and what an agent is told when the
// repository refuses it (Tonoman Cloud docs/definition/objects/brain.md). PURE, all of it.

/** A second-brain source a wired agent carries on its roster, and the ref of the credential that
 *  opens it — to be resolved for the agent that carries it (`guid`). */
export interface LegacySource {
  id: string;
  tenant: string;
  repoUrl: string;
  secretRef: string;
  guid?: string;
  branch?: string | null;
  subpath?: string | null;
  readOnly?: boolean;
}

/** What is known of the brain being opened. `kind` and `slug` are how an ADOPTED brain is told from
 *  any other brain that merely points at the same repository. */
export interface BrainToOpen {
  tenant: string;
  repoUrl: string;
  kind?: "personal" | "shared";
  slug?: string;
  branch?: string | null;
  subpath?: string | null;
}

export type Credential = { ref: string; guid?: string } | { fault: string };

/** One repository, however its address is written: no trailing slash, no `.git`, host in lower case. */
export function sameRepo(url: string): string {
  const bare = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  try {
    const u = new URL(bare);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  } catch {
    return bare;
  }
}

/** The slug the Cloud gives a brain it adopted from a source: `second-brain-` and the first six hex
 *  of the SOURCE's id (reach.ts, adoptLegacySources). It is the binding between the two. */
export const adoptedSlug = (sourceId: string): string => `second-brain-${sourceId.replace(/-/g, "").slice(0, 6)}`;

const place = (s: string | null | undefined): string => (s ?? "").trim().replace(/^\/+|\/+$/g, "");

/** BRAIN-REACHED-WITH-ITS-OWN-CREDENTIAL.
 *
 *  A brain the Cloud ADOPTED from a second-brain source is that repository, and is reached with
 *  that source's credential, whichever host it is on. "Adopted" is proved, not inferred from an
 *  address: the brain is `shared`, its slug is the one made from that source's id, and tenant,
 *  repository, branch and folder all agree. A personal brain that merely points at the same
 *  repository proves none of that and borrows nothing.
 *
 *  - A read-only source is never bound: the brain store pushes with the token it is given, and a
 *    restriction on the source must not be widened by reaching it as a brain.
 *  - Two sources that both prove the binding and name different credentials are a fault in how the
 *    tenant is set up. Which one "wins" is never decided by the order of a roster.
 *  - A brain Tonoman made itself lives under the organisation and project Tonoman provisions into,
 *    and only there is the brains' own credential used. A brain whose source was found and could
 *    not be bound does NOT fall back to it.
 *
 *  Before this, only a dev.azure.com address was given any credential at all. */
export function brainCredential(b: BrainToOpen, sources: LegacySource[], ado: { secret: string; org?: string; project?: string }): Credential {
  const repo = sameRepo(b.repoUrl);
  const sameRepoInTenant = sources.filter((s) => s.tenant === b.tenant && sameRepo(s.repoUrl) === repo);
  const bound = sameRepoInTenant.filter(
    (s) => b.kind === "shared" && b.slug === adoptedSlug(s.id) && place(s.branch) === place(b.branch) && place(s.subpath) === place(b.subpath),
  );
  if (bound.length) {
    if (bound.some((s) => s.readOnly)) return { fault: "its source is read-only, and a brain is written to with the credential it is read with" };
    const refs = [...new Set(bound.map((s) => s.secretRef).filter(Boolean))];
    if (refs.length === 0) return { fault: "its source names no credential" };
    if (refs.length > 1) return { fault: "its source is carried by more than one agent with different credentials" };
    const s = bound.find((x) => x.secretRef === refs[0])!;
    return s.guid ? { ref: s.secretRef, guid: s.guid } : { ref: s.secretRef };
  }
  // The repository IS one of this tenant's sources, and this brain could not prove it was adopted
  // from it: it does not get the brains' general credential instead.
  if (sameRepoInTenant.length) return { fault: "it points at one of the tenant's second-brain repositories without being the brain adopted from it" };
  if (ado.secret && ado.org && ado.project) {
    const home = `https://dev.azure.com/${ado.org}/${ado.project}/_git/`.toLowerCase();
    if (b.repoUrl.trim().toLowerCase().startsWith(home)) return { ref: ado.secret };
  }
  return { fault: "there is no credential for where it lives" };
}

/** What a repository says when it will not have the credential — as against a network that is down. */
const REFUSED = /authentication failed|invalid username or token|could not read username|terminal prompts disabled|repository not found|permission denied|\b(401|403)\b|no credential to be reached with/i;

/** True when a failure is a fault in how the brain is set up, which trying again will not change. */
export const isSetupFault = (message: string): boolean => REFUSED.test(message);

export const SETUP_FAULT_TEXT =
  "This brain's repository will not accept the credential Tonoman has for it. That is a fault in how the brain is set up: trying again will not help, so do not. Tell the person it needs an admin to put right, and answer from what you already have.";
export const PASSING_FAULT_TEXT = "The brain could not be reached just now; say so rather than guessing.";

/** BRAIN-REFUSED-IS-NOT-RETRIED. A refused credential is said as the set-up fault it is; "just now"
 *  is kept for what may pass. On Sep 20 a refusal was called "just now", and one turn tried thirteen
 *  times and spent 364k tokens. */
export const brainFailureText = (message: string): string => (isSetupFault(message) ? SETUP_FAULT_TEXT : PASSING_FAULT_TEXT);

/** Whether this deployment MAKES brains (BRAIN-MAKING-CAN-BE-OFF): it needs somewhere to make them —
 *  an organisation and a project — and making not switched off. Off, the same organisation and
 *  project still say which repos the brains' own credential may be used on (`brainCredential`), so an
 *  operator's existing repo is reached while nobody's personal brain gets a repo made for it. */
export function makesBrains(env: { TONOMAN_BRAIN_ADO_ORG?: string; TONOMAN_BRAIN_ADO_PROJECT?: string; TONOMAN_BRAIN_MAKE?: string }): boolean {
  if (!env.TONOMAN_BRAIN_ADO_ORG || !env.TONOMAN_BRAIN_ADO_PROJECT) return false;
  return (env.TONOMAN_BRAIN_MAKE ?? "").trim().toLowerCase() !== "off";
}
