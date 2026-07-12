// Pure validation for the `/model` command (gw-command-model). The model name is
// validated at command time — a typo is rejected immediately with the valid options,
// so it never degrades into a cryptic failed turn later. We accept the friendly
// aliases the Claude CLI understands plus any full `claude-*` model id (those evolve,
// so we pass them through rather than pin a list). Anything else is rejected.

/** Friendly model aliases the Claude Code CLI accepts directly. */
export const KNOWN_ALIASES = ["sonnet", "opus", "haiku"] as const;

/** Human-facing list of what `/model` accepts (shown on a rejected name). */
export function modelHint(): string {
  return `${KNOWN_ALIASES.join(", ")}, or a full claude-* id (e.g. claude-opus-4-8)`;
}

export type ModelValidation = { ok: true; model: string } | { ok: false; error: string };

/** Validates a model name for `/model <name>`. Case-insensitive; returns the
 * normalized (lower-cased) name on success. `default`/`reset` are NOT handled here —
 * the dispatcher treats those as "clear the override" before calling this. */
export function validateModelName(raw: string): ModelValidation {
  const name = (raw ?? "").trim().toLowerCase();
  if (!name) return { ok: false, error: `Usage: /model <name> — ${modelHint()}` };
  if ((KNOWN_ALIASES as readonly string[]).includes(name)) return { ok: true, model: name };
  // Full model ids: claude-<family>-<version> (letters, digits, dots, dashes).
  if (/^claude-[a-z0-9][a-z0-9.\-]*$/.test(name)) return { ok: true, model: name };
  return { ok: false, error: `Unknown model "${raw.trim()}". Valid: ${modelHint()}` };
}

/** The family of a model id: "claude-opus-4-8" → "opus", "claude-fable-5" → "fable". */
export function familyOf(id: string): string {
  const m = /^claude-([a-z]+)/.exec(id);
  return m ? m[1] : id;
}

/** Builds the `/model` picker choices (gw-command-model). From the live model ids (newest-first,
 * as `/v1/models` returns them) it keeps the **latest per family** as `{label: family, data:
 * "/model <id>"}`; when the list is empty (fetch failed) it falls back to the in-code aliases.
 * Always ends with a "default" (reset) choice. PURE. */
export function modelChoices(ids: string[]): { label: string; data: string }[] {
  const out: { label: string; data: string }[] = [];
  if (ids.length) {
    const seen = new Set<string>();
    for (const id of ids) {
      const fam = familyOf(id);
      if (seen.has(fam)) continue; // first per family = latest (API lists newest-first)
      seen.add(fam);
      out.push({ label: fam, data: `/model ${id}` });
    }
  } else {
    for (const a of KNOWN_ALIASES) out.push({ label: a, data: `/model ${a}` });
  }
  out.push({ label: "default", data: "/model default" });
  return out;
}

/** Lists available model ids from the Anthropic models API (account-scoped, via the agent's
 * OAuth token). Returns [] on any failure — the picker then falls back to the in-code aliases. */
export async function fetchModelIds(token: string): Promise<string[]> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "User-Agent": "claude-code/2.1.0",
      },
    });
    if (!res.ok) return [];
    const p = (await res.json()) as { data?: Array<{ id?: string }> };
    return Array.isArray(p.data) ? p.data.map((m) => m.id).filter((x): x is string => !!x) : [];
  } catch {
    return [];
  }
}
