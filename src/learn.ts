// The memory substrate (learn-durable): an agent persists what it learns so it survives /new, restart,
// and pod replacement. This module is the harness- and channel-neutral CORE — a single persist() seam
// that ROUTES a durable write by ownership scope and drives a GitAdapter. The adapter (git today) is the
// only thing that touches the network/credentials, so this logic is fully unit-testable with git faked.
//
//   personal → the agent's OWN brain repo, commit to main   (no gate: its private brain)
//   shared   → the org's config_repo skill registry, open a PR   (reviewed; no live self-edit)
//
// The confirm-before-write gate (learn-confirm-before-write) lives at the INVOCATION layer (the agent
// asks the user, stating scope + destination, before calling persist) — persist() itself is the
// mechanism, not the policy. See docs/scenarios/contracts/learn-durable.md.

/** Who owns the artifact being written — the routing axis (NOT "memory vs skill"). */
export type Scope = "personal" | "shared";

/** One durable-write request. */
export interface PersistRequest {
  scope: Scope;
  /** personal: the brain policy file to write (default "LEARNED.md"). shared: the skill NAME
   * (→ config_repo/skills/<target>/SKILL.md). */
  target?: string;
  /** the content to persist — the rule to record, or the new skill body. */
  content: string;
  /** why, in one line — goes into the commit message / PR title+body (kept human, no secrets). */
  reason: string;
}

/** What the caller reports back to the user — a durable write is NEVER silent. */
export interface Receipt {
  scope: Scope;
  mode: "commit" | "pr";
  /** commit SHA (personal) or PR URL (shared). */
  ref: string;
  /** a one-line human summary the agent can relay verbatim. */
  summary: string;
}

/** The git operations the substrate needs. The live impl shells git/`gh`; tests fake it. Keeping this
 * an interface is what makes persist() free to unit-test (no network, no tokens). */
export interface GitAdapter {
  /** Write `file` in the agent's OWN brain repo and commit to `main` (+ push). Returns the commit SHA. */
  commitToMain(input: { file: string; content: string; message: string }): Promise<string>;
  /** Open a PR against the org config repo carrying a change at `path`. Returns the PR URL. */
  openPr(input: { branch: string; path: string; content: string; title: string; body: string }): Promise<string>;
}

export interface PersistDeps {
  git: GitAdapter;
  /** the org's shared skill registry repo; undefined = personal-only org (learn-registry-from-config):
   * a shared write is refused, never mis-routed to the agent's own repo. */
  configRepo?: string;
}

/** kebab-slug for a branch name — deterministic (no clock/random) so a retry of the same learning
 * targets the same branch instead of spawning duplicates. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";
}

function prBody(req: PersistRequest): string {
  return `Proposed by an agent via the tonoman learn substrate.\n\n**Skill:** ${req.target}\n**Reason:** ${req.reason}\n\nReview and merge to apply org-wide; agents pick it up on the next re-pull.`;
}

/** Route a durable write to the right git and return the receipt. Throws (never silently drops) on a
 * shared write with no registry, or a shared write with no target skill. */
export async function persist(req: PersistRequest, deps: PersistDeps): Promise<Receipt> {
  if (req.scope === "personal") {
    const file = req.target || "LEARNED.md";
    const sha = await deps.git.commitToMain({ file, content: req.content, message: `learn: ${req.reason}` });
    return {
      scope: "personal",
      mode: "commit",
      ref: sha,
      summary: `Saved to your brain (main) — ${req.reason} [${sha.slice(0, 7)}]`,
    };
  }
  // shared
  if (!deps.configRepo) {
    throw new Error("learn: no shared skill registry configured (config_repo unset) — cannot persist a shared-skill change");
  }
  if (!req.target) {
    throw new Error("learn: a shared-skill write needs a target skill name");
  }
  const url = await deps.git.openPr({
    branch: `learn/${req.target}-${slug(req.reason)}`,
    path: `skills/${req.target}/SKILL.md`,
    content: req.content,
    title: `skill(${req.target}): ${req.reason}`,
    body: prBody(req),
  });
  return {
    scope: "shared",
    mode: "pr",
    ref: url,
    summary: `Proposed a change to the shared "${req.target}" skill — pending review: ${url}`,
  };
}
