import { describe, it, expect } from "vitest";
import { validateModelName, modelHint, KNOWN_ALIASES, familyOf, modelChoices } from "./modelcmd";

describe("validateModelName — /model is validated at command time (gw-command-model)", () => {
  it("accepts the friendly aliases (case-insensitive), normalized to lower-case", () => {
    for (const a of KNOWN_ALIASES) {
      expect(validateModelName(a)).toEqual({ ok: true, model: a });
      expect(validateModelName(a.toUpperCase())).toEqual({ ok: true, model: a });
    }
    expect(validateModelName("  Opus  ")).toEqual({ ok: true, model: "opus" });
  });

  it("accepts full claude-* model ids and passes them through (lower-cased)", () => {
    expect(validateModelName("claude-opus-4-8")).toEqual({ ok: true, model: "claude-opus-4-8" });
    expect(validateModelName("claude-sonnet-4-6")).toEqual({ ok: true, model: "claude-sonnet-4-6" });
    expect(validateModelName("Claude-Haiku-4-5-20251001")).toEqual({ ok: true, model: "claude-haiku-4-5-20251001" });
  });

  it("rejects junk immediately, listing the valid options (no cryptic failed turn later)", () => {
    const r = validateModelName("gpt-4");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Unknown model");
      expect(r.error).toContain("sonnet");
      expect(r.error).toContain("claude-");
    }
    expect(validateModelName("opusy").ok).toBe(false); // near-miss is still a miss
    expect(validateModelName("claude-").ok).toBe(false); // bare prefix is not an id
  });

  it("treats empty as a usage hint, not a model", () => {
    const r = validateModelName("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage");
  });

  it("modelHint lists the aliases and the claude-* form", () => {
    expect(modelHint()).toContain("sonnet");
    expect(modelHint()).toContain("claude-");
  });
});

describe("modelChoices / familyOf — the /model picker (gw-command-model)", () => {
  it("familyOf extracts the family from a model id", () => {
    expect(familyOf("claude-opus-4-8")).toBe("opus");
    expect(familyOf("claude-fable-5")).toBe("fable");
    expect(familyOf("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("keeps the latest per family (newest-first list) + a default choice; data is /model <id>", () => {
    const ids = ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    expect(modelChoices(ids)).toEqual([
      { label: "fable", data: "/model claude-fable-5" },
      { label: "opus", data: "/model claude-opus-4-8" }, // 4-8 first-seen ⇒ wins over 4-7
      { label: "sonnet", data: "/model claude-sonnet-4-6" },
      { label: "haiku", data: "/model claude-haiku-4-5-20251001" },
      { label: "default", data: "/model default" },
    ]);
  });

  it("falls back to the in-code aliases when the model list is empty (fetch failed)", () => {
    expect(modelChoices([])).toEqual([
      ...KNOWN_ALIASES.map((a) => ({ label: a, data: `/model ${a}` })),
      { label: "default", data: "/model default" },
    ]);
  });
});
