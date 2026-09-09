// The skill language, and the parts of the interpreter that are worth testing without a worker.
//
// A skill is a ROW; Temporal is the interpreter. A durable sequence of steps with retries IS a
// Temporal workflow, so "just write a workflow" is the tempting answer and the wrong one: a workflow
// is code, and a skill is a row. A tenant cannot have a different workflow without a deploy.
//
// TWO STEP KINDS, AND THAT IS THE LINE.
//
//   tool   a named verb the runtime executes. Succeeds or fails on its result.
//   infer  a prompt, and the SHAPE the answer must take.
//
// No branching, no loops, no expressions. A conditional means it is code, or it is two skills. The
// rule that keeps this from becoming n8n: a new step kind has to delete a bespoke pipeline to earn
// its place.
//
// WHY INFERENCE IS NEVER TRUSTED WITH THE COMMIT. The failure this shape exists to prevent is an
// agent that summarises beautifully and simply does not call the step that writes the file — a turn
// that skipped its last instruction is indistinguishable from one that succeeded, because the only
// witness is the model's own account of itself. So inference produces VALUES; code decides what
// happens to them. `publish` is its own step, run by code, checked by its result.

/** A value in the run's context. Anything a step returns and a later step may declare. */
export type Value = unknown;

/** What a step is given and what it leaves behind. Accumulates across the run — but see
 *  `visibleTo`: what a step SEES is only what it declared. */
export type Bag = Record<string, Value>;

export interface ToolStep {
  id: string;
  /** The verb, e.g. `brain publish`. A NAME the runtime resolves in its own registry — never a
   *  command line. A step that shelled out would need a tenant credential inside the agent's shell,
   *  and the agent is a language model with a shell; today the worker resolves credentials and hands
   *  the harness results, never secrets. */
  tool: string;
  /** Literals from the definition. `$item` is substituted with the item this run is for. */
  args?: Record<string, unknown>;
  /** Names from the bag. A LIST, never an expression. */
  in?: string[];
  /** Where this step's result is filed in the bag. Absent means the step is done for its effect. */
  out?: string;
}

export interface InferStep {
  id: string;
  infer: {
    /** Which prompt, by name. The runtime owns the text; the row owns the choice. */
    prompt: string;
    in: string[];
    out: string;
    /** The shape the answer must take. A response that does not conform FAILS the step — which is
     *  the difference between a value and a claim. */
    schema: string;
  };
}

export type Step = ToolStep | InferStep;

export function isInfer(s: Step): s is InferStep {
  return (s as InferStep).infer !== undefined;
}

/** What a step declared it needs, whichever kind it is. */
export function declaredIn(s: Step): string[] {
  return isInfer(s) ? (s.infer.in ?? []) : (s.in ?? []);
}

/** Where a step files its result, or undefined for one that runs only for its effect. */
export function declaredOut(s: Step): string | undefined {
  return isInfer(s) ? s.infer.out : s.out;
}

/**
 * PURE: a step's entire world.
 *
 * A STEP SEES WHAT IT DECLARES, NOT THE WHOLE BAG. Handing every value to every step would make a
 * step's behaviour depend on whatever an earlier one happened to leave lying around — two runs of
 * the same skill differing for a reason nothing records. It is the declared inputs that make an
 * output schema, and any future caching of a step, mean anything at all.
 *
 * A name that is declared but absent arrives as `undefined` rather than being dropped, so a step can
 * tell "nothing was produced" from "I never asked".
 */
export function visibleTo(step: Step, bag: Bag): Bag {
  const seen: Bag = {};
  for (const name of declaredIn(step)) seen[name] = bag[name];
  return seen;
}

/**
 * PURE: literals from the definition, with `$item` filled in.
 *
 * Positional substitution by name, deliberately — a template rather than a language. The moment this
 * grows `${a.b || c}` it is an evaluator, with a syntax and error messages of its own to own.
 */
export function resolveArgs(args: Record<string, unknown> | undefined, itemKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = v === "$item" ? itemKey : v;
  return out;
}

/**
 * PURE: is this step list runnable at all?
 *
 * Checked ONCE, before the first step, rather than discovered at step five with three side effects
 * already committed. A skill that names an input nothing produces is a broken definition, and it
 * must fail as one — loudly, at the start — instead of quietly handing `undefined` to a summariser
 * and producing a confident recap with a piece missing.
 */
export function validateSteps(steps: Step[]): string[] {
  const problems: string[] = [];
  if (steps.length === 0) problems.push("a skill with no steps does nothing");

  const ids = new Set<string>();
  const produced = new Set<string>();
  for (const [i, s] of steps.entries()) {
    const where = `step ${i + 1}${s.id ? ` (${s.id})` : ""}`;
    if (!s.id) problems.push(`${where} has no id`);
    else if (ids.has(s.id)) problems.push(`${where} repeats an id`);
    ids.add(s.id);

    if (isInfer(s)) {
      if (!s.infer.prompt) problems.push(`${where} is an infer step with no prompt`);
      if (!s.infer.out) problems.push(`${where} is an infer step that files its answer nowhere`);
      if (!s.infer.schema) problems.push(`${where} is an infer step with no schema — its answer could not be checked`);
    } else if (!s.tool) {
      problems.push(`${where} is neither a tool nor an infer step`);
    }

    // DECLARED BEFORE USE, in order. There are no loops and no branches, so "an earlier step
    // produced it" is a complete definition of availability — which is exactly what makes a flat
    // step list checkable at all.
    for (const name of declaredIn(s)) {
      if (!produced.has(name)) problems.push(`${where} needs "${name}", which no earlier step produces`);
    }
    const out = declaredOut(s);
    if (out) {
      if (produced.has(out)) problems.push(`${where} overwrites "${out}", which an earlier step already produced`);
      produced.add(out);
    }
  }
  return problems;
}

/** How big a value may be before it travels by REFERENCE rather than through workflow state.
 *
 *  Temporal warns past 256KB and refuses past 2MB, and a 42,000-character transcript is well on its
 *  way. This works perfectly on a five-minute recording and breaks on an eighty-eight-minute one,
 *  which is why the threshold is settled here rather than discovered in production. */
export const INLINE_LIMIT = 64 * 1024;

/** A value the workflow carries as a pointer instead of a payload. */
export interface Ref {
  $ref: string;
  bytes: number;
}

export function isRef(v: unknown): v is Ref {
  return typeof v === "object" && v !== null && typeof (v as Ref).$ref === "string";
}

/** PURE: would this value have to travel by reference? */
export function tooBigToInline(v: Value): boolean {
  if (typeof v === "string") return v.length > INLINE_LIMIT;
  if (v === undefined || v === null) return false;
  try {
    return JSON.stringify(v).length > INLINE_LIMIT;
  } catch {
    // Circular, or otherwise not serialisable. It cannot go through workflow state either way, and
    // saying so here is better than a Temporal error about a payload nobody can see.
    return true;
  }
}
