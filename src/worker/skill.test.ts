// The skill language: what a step may say, what it may see, and what makes a definition broken.
//
// These are the rules that keep a step list from becoming a programming language. Each one is a
// restriction, and a test is the only place a restriction stays real — the pressure to add "just an
// expression here" arrives later, from somebody with a good reason.

import { describe, expect, it } from "vitest";
import {
  INLINE_LIMIT,
  declaredIn,
  declaredOut,
  isInfer,
  isRef,
  resolveArgs,
  tooBigToInline,
  validateSteps,
  visibleTo,
  type Step,
} from "./skill";

const tool = (id: string, over: Partial<Extract<Step, { tool: string }>> = {}): Step => ({
  id,
  tool: "mission get",
  ...over,
});

const infer = (id: string, over: Record<string, unknown> = {}): Step => ({
  id,
  infer: { prompt: "recap-vs-mission", in: [], out: `${id}-out`, schema: "Recap", ...over },
} as Step);

describe("the two step kinds, and telling them apart", () => {
  it("recognises an infer step by the shape of the row, not by a kind column", () => {
    expect(isInfer(infer("a"))).toBe(true);
    expect(isInfer(tool("a"))).toBe(false);
  });

  it("reads inputs and outputs the same way for both kinds", () => {
    expect(declaredIn(tool("a", { in: ["x", "y"] }))).toEqual(["x", "y"]);
    expect(declaredIn(infer("a", { in: ["x"] }))).toEqual(["x"]);
    expect(declaredOut(tool("a", { out: "z" }))).toBe("z");
    expect(declaredOut(infer("a"))).toBe("a-out");
  });

  it("treats a step with no `out` as one that runs for its EFFECT", () => {
    // `say` is the case, and it is not a gap: announcing produces no value anything else consumes.
    expect(declaredOut(tool("announce"))).toBeUndefined();
  });
});

describe("a step sees what it DECLARED, and nothing else", () => {
  const bag = { transcript: "words", mission: "grow", candidates: [1, 2], secret: "should not travel" };

  it("hands over only the declared names", () => {
    // Handing every value to every step would make a step's behaviour depend on whatever an earlier
    // one happened to leave lying around — two runs of the same skill differing for a reason nothing
    // records.
    expect(visibleTo(tool("a", { in: ["transcript", "mission"] }), bag)).toEqual({
      transcript: "words",
      mission: "grow",
    });
  });

  it("gives a step that declares nothing an EMPTY world", () => {
    expect(visibleTo(tool("a"), bag)).toEqual({});
  });

  it("passes a declared-but-absent name as undefined rather than dropping it", () => {
    // So a step can tell "nothing was produced" from "I never asked for it".
    expect(visibleTo(tool("a", { in: ["nothing"] }), bag)).toEqual({ nothing: undefined });
  });

  it("does the same for an infer step, which is the one that talks to a model", () => {
    expect(visibleTo(infer("a", { in: ["mission"] }), bag)).toEqual({ mission: "grow" });
  });
});

describe("args are a template, not a language", () => {
  it("substitutes $item and leaves every other literal alone", () => {
    expect(resolveArgs({ id: "$item", limit: 20, mode: "full" }, "rec-1")).toEqual({
      id: "rec-1",
      limit: 20,
      mode: "full",
    });
  });

  it("does not evaluate anything that merely LOOKS like an expression", () => {
    // The moment this resolves `${a.b || c}` it is an evaluator, with a syntax and error messages of
    // its own to own. It stays a positional substitution by name.
    expect(resolveArgs({ a: "${item}", b: "$item.id", c: "$items" }, "rec-1")).toEqual({
      a: "${item}",
      b: "$item.id",
      c: "$items",
    });
  });

  it("handles a step with no args at all", () => {
    expect(resolveArgs(undefined, "rec-1")).toEqual({});
  });
});

describe("validateSteps — a broken definition must fail at the START", () => {
  // Checked once, before the first step, rather than discovered at step five with three side effects
  // already committed.

  it("accepts the real meeting-recap step list", () => {
    const steps: Step[] = [
      tool("transcript", { tool: "transcript get", args: { id: "$item" }, out: "transcript" }),
      tool("calendar", { tool: "calendar candidates", out: "candidates" }),
      tool("mission", { tool: "mission get", out: "mission" }),
      infer("recap", { in: ["transcript", "candidates", "mission"], out: "recap" }),
      tool("publish", { tool: "brain publish", in: ["recap", "transcript", "mission"], out: "published" }),
      tool("announce", { tool: "say", in: ["recap", "published"] }),
    ];
    expect(validateSteps(steps)).toEqual([]);
  });

  it("refuses a step that needs something no earlier step produces", () => {
    // The alternative is handing `undefined` to a summariser and publishing a confident recap with
    // a piece silently missing.
    const problems = validateSteps([tool("publish", { in: ["recap"] })]);
    expect(problems.join(" ")).toMatch(/needs "recap"/);
  });

  it("refuses a name produced LATER than it is used, because there are no loops", () => {
    const problems = validateSteps([
      tool("a", { in: ["late"] }),
      tool("b", { out: "late" }),
    ]);
    expect(problems.join(" ")).toMatch(/needs "late"/);
  });

  it("refuses two steps writing the same name", () => {
    // Silently overwriting means a later step reads a value produced by whichever step happened to
    // run last — the definition would no longer say what it does.
    const problems = validateSteps([tool("a", { out: "x" }), tool("b", { out: "x" })]);
    expect(problems.join(" ")).toMatch(/overwrites "x"/);
  });

  it("refuses repeated ids, and a step that is neither kind", () => {
    expect(validateSteps([tool("a"), tool("a")]).join(" ")).toMatch(/repeats an id/);
    expect(validateSteps([{ id: "a" } as Step]).join(" ")).toMatch(/neither a tool nor an infer step/);
  });

  it("refuses an infer step with no schema — an answer that could not be checked", () => {
    // A response that does not conform must FAIL the step. That is the difference between a value
    // and a claim, and it is the whole reason this is a step list rather than one long prompt.
    expect(validateSteps([infer("a", { schema: "" })]).join(" ")).toMatch(/no schema/);
    expect(validateSteps([infer("a", { out: "" })]).join(" ")).toMatch(/files its answer nowhere/);
  });

  it("refuses an empty skill", () => {
    expect(validateSteps([]).join(" ")).toMatch(/no steps/);
  });

  it("reports EVERY problem, not just the first", () => {
    // A definition fixed one error at a time across six deploys is how a config format earns its
    // reputation.
    expect(validateSteps([tool("a", { in: ["x"] }), tool("a", { in: ["y"] })]).length).toBeGreaterThan(2);
  });
});

describe("large values travel by reference", () => {
  // A 42,000-character transcript through workflow state runs into Temporal's payload limits, and an
  // 88-minute meeting is 55,000 characters before anything else is in the bag. This works perfectly
  // on a five-minute recording and breaks on a long one — which is why it is settled, not discovered.

  it("leaves a short value inline, because a pointer to eleven characters is slower eleven characters", () => {
    expect(tooBigToInline("hello")).toBe(false);
    expect(tooBigToInline({ a: 1 })).toBe(false);
    expect(tooBigToInline(undefined)).toBe(false);
  });

  it("sends a long transcript by reference", () => {
    expect(tooBigToInline("x".repeat(INLINE_LIMIT + 1))).toBe(true);
  });

  it("sends a large structure by reference too — a calendar can be long", () => {
    expect(tooBigToInline(Array.from({ length: 20000 }, (_, i) => ({ summary: `event ${i}` })))).toBe(true);
  });

  it("treats a value it cannot serialise as too big, rather than failing later inside Temporal", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(tooBigToInline(circular)).toBe(true);
  });

  it("recognises a reference when it comes back", () => {
    expect(isRef({ $ref: "/tmp/x.txt", bytes: 10 })).toBe(true);
    expect(isRef("just a string")).toBe(false);
    expect(isRef(null)).toBe(false);
  });
});
