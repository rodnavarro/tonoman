// The brokered container-dev runtime engine (architecture A13): given an agent's
// requested podman command, it decides allow/deny (allowlist: verb × flag ×
// ownership), rewrites grant-relative mount sources to host paths, and namespaces
// resources per agent. This module is PURE logic — no podman, no I/O — so it is
// unit-testable and is where the generic engine's correctness is asserted (the
// bulk of devcontainerized's coverage lives here).

/** A granted mount root: maps an agent-visible path (~/files/<name>, A9) to its host path. */
export interface Grant {
  /** agent's view, e.g. /root/files/acme */
  agentPath: string;
  /** host path host-podman resolves, e.g. /host/acme */
  hostPath: string;
  readOnly?: boolean;
}

/** One agent's runtime authorization (A13). With no grants, any host-path mount is denied. */
export interface Policy {
  /** agent GUID, for namespacing (A11) */
  guid: string;
  /** granted mount roots */
  grants: Grant[];
  /** owner-widened verbs beyond the default set (owner-responsible) */
  extraVerbs?: string[];
}

/** Thrown when the policy refuses a command. Carries a human-readable reason. */
export class DenyError extends Error {
  constructor(reason: string) {
    super(`denied by policy: ${reason}`);
    this.name = "DenyError";
  }
}

// The safe dev allowlist (A13). Unknown verb => denied.
const DEFAULT_VERBS = new Set<string>([
  "run", "create", "build", "compose", "ps",
  "logs", "exec", "cp", "pull", "images",
  "image", "stop", "start", "rm", "restart",
  "network", "volume", "inspect", "kill", "wait",
  "healthcheck", "version", "info", "port",
]);

// Flags never allowed, even if an owner widens the policy: they hand over
// privilege or escape the sandbox boundary (A13 hard floor). Matched by exact
// token or `flag=...` prefix.
const DENIED_FLAGS = ["--privileged", "--device", "--cap-add", "--security-opt"];

// Namespace flags take a value; only the dangerous values ("host", "container:*")
// are denied — other values (e.g. a user-defined network) pass through.
const NS_FLAGS = new Set<string>([
  "--network", "--net", "--pid", "--ipc", "--userns", "--uts", "--cgroupns",
]);

// Path-bearing flags whose value is a host path to rewrite — but ONLY for the
// `compose` verb. (`-f` is overloaded: `logs -f`=follow, `ps -f`=filter — so this
// rewrite must stay verb-scoped or it would corrupt those.)
const COMPOSE_PATH_FLAGS = new Set<string>(["-f", "--file", "--project-directory", "--env-file"]);

// Verbs that actually accept a host bind mount via -v/--volume/--mount. For any other
// verb (notably `exec`), `-v` is the *in-container command's* own flag (e.g.
// `pg_restore -v` = verbose) and must pass through untouched — rewriting it wrongly
// denied a real restore in the live test. Same overload class as `-f` above.
const VOLUME_VERBS = new Set<string>(["run", "create", "build"]);

/** Reports whether a path is absolute (POSIX root or a Windows drive). */
function isAbsolutePath(p: string): boolean {
  const s = p.replace(/\\/g, "/");
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

function isAlpha(b: string): boolean {
  return (b >= "a" && b <= "z") || (b >= "A" && b <= "Z");
}

/** Splits "--flag=val" into {base:"--flag", val:"val", hasVal:true}; "--flag" => hasVal:false. */
function splitFlag(tok: string): { base: string; val: string; hasVal: boolean } {
  if (!tok.startsWith("-")) return { base: tok, val: "", hasVal: false };
  const i = tok.indexOf("=");
  if (i >= 0) return { base: tok.slice(0, i), val: tok.slice(i + 1), hasVal: true };
  return { base: tok, val: "", hasVal: false };
}

/** Strips a `=value` suffix for error messages. */
function flagName(tok: string): string {
  const i = tok.indexOf("=");
  return i >= 0 ? tok.slice(0, i) : tok;
}

/**
 * Splits "src:dst:opts" into [src, "dst:opts"], tolerating Windows drive letters
 * (C:/...) by treating a single leading letter + ":" as part of src.
 */
function splitVolumeSrc(spec: string): [src: string, rest: string] {
  let start = 0;
  if (spec.length >= 2 && spec[1] === ":" && isAlpha(spec[0])) start = 2;
  const i = spec.indexOf(":", start);
  if (i >= 0) return [spec.slice(0, i), spec.slice(i + 1)];
  return [spec, ""];
}

/**
 * Reports whether src is a podman named volume (no path separators, not a Windows
 * drive path, not a relative/home path) rather than a host bind source.
 */
function isNamedVolume(src: string): boolean {
  if (src === "") return false;
  if (/[/\\]/.test(src)) return false;
  if (src.length >= 2 && src[1] === ":" && isAlpha(src[0])) return false; // C: drive
  if (src.startsWith(".") || src.startsWith("~")) return false;
  return true;
}

function verbAllowed(p: Policy, v: string): boolean {
  if (DEFAULT_VERBS.has(v)) return true;
  return (p.extraVerbs ?? []).includes(v);
}

/**
 * Maps an agent-view absolute path to its host path via a grant, or throws a
 * DenyError if it falls outside every grant (A13 ownership/grant constraint).
 */
function mapHostPath(p: Policy, src: string): string {
  const s = src.replace(/\\/g, "/");
  for (const g of p.grants) {
    const gp = g.agentPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (s === gp) return g.hostPath;
    if (s.startsWith(gp + "/")) {
      return g.hostPath.replace(/\/+$/, "") + s.slice(gp.length);
    }
  }
  throw new DenyError(`mount source "${src}" is outside the agent's grants`);
}

/**
 * Validates+rewrites a `-v src:dst[:opts]` spec. Named volumes pass through;
 * host-path sources must sit under a grant and are mapped to the host path.
 */
function rewriteVolume(p: Policy, spec: string): string {
  const [src, rest] = splitVolumeSrc(spec);
  if (isNamedVolume(src)) return spec; // podman-managed named volume; broker namespaces it
  const host = mapHostPath(p, src);
  return rest === "" ? host : `${host}:${rest}`;
}

/** Validates+rewrites a `--mount type=...,source=...,target=...` spec. */
function rewriteMount(p: Policy, spec: string): string {
  const parts = spec.split(",");
  for (let idx = 0; idx < parts.length; idx++) {
    const eq = parts[idx].indexOf("=");
    if (eq < 0) continue;
    const k = parts[idx].slice(0, eq);
    const v = parts[idx].slice(eq + 1);
    if (k === "source" || k === "src") {
      if (isNamedVolume(v)) return spec;
      const host = mapHostPath(p, v);
      parts[idx] = `${k}=${host}`;
    }
  }
  return parts.join(",");
}

/**
 * Checks a podman argv against the policy and returns a rewritten argv (mount
 * sources mapped from agent view to host paths) to run host-side, or throws a
 * DenyError. argv is the podman command WITHOUT the leading "podman".
 */
export function authorize(p: Policy, argv: string[]): string[] {
  if (argv.length === 0) throw new DenyError("empty command");
  const verb = argv[0];
  if (!verbAllowed(p, verb)) throw new DenyError(`verb "${verb}" not in allowlist`);

  const out: string[] = [verb];

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];

    // Hard-floor denied flags (privilege / escape vectors): exact token or `flag=`.
    for (const d of DENIED_FLAGS) {
      if (tok === d || tok.startsWith(d + "=")) {
        throw new DenyError(`flag "${flagName(tok)}" is not permitted`);
      }
    }

    const { base, val, hasVal } = splitFlag(tok);

    // Namespace flags: deny only the dangerous values.
    if (NS_FLAGS.has(base)) {
      let v = val;
      if (!hasVal && i + 1 < argv.length) v = argv[i + 1];
      if (v === "host" || v.startsWith("container:")) {
        throw new DenyError(`${base} ${v} breaks isolation`);
      }
      out.push(tok);
      continue;
    }

    // -v / --volume : rewrite/validate the source — only for verbs that take a host
    // mount. Elsewhere (`exec … -v`) it is the in-container command's flag → falls through.
    if ((base === "-v" || base === "--volume") && VOLUME_VERBS.has(verb)) {
      let spec = val;
      let consumedNext = false;
      if (!hasVal) {
        if (i + 1 >= argv.length) throw new DenyError("dangling -v");
        spec = argv[i + 1];
        consumedNext = true;
      }
      const rw = rewriteVolume(p, spec);
      if (hasVal) out.push(`${base}=${rw}`);
      else out.push(base, rw);
      if (consumedNext) i++;
      continue;
    }

    // compose path flags (-f / --project-directory / --env-file): rewrite an
    // absolute grant-relative value to its host path; a relative value passes
    // through (the rewritten cwd resolves it host-side).
    if (verb === "compose" && COMPOSE_PATH_FLAGS.has(base)) {
      let val2 = val;
      let consumedNext = false;
      if (!hasVal) {
        if (i + 1 >= argv.length) throw new DenyError(`dangling ${base}`);
        val2 = argv[i + 1];
        consumedNext = true;
      }
      const rw = isAbsolutePath(val2) ? mapHostPath(p, val2) : val2;
      if (hasVal) out.push(`${base}=${rw}`);
      else out.push(base, rw);
      if (consumedNext) i++;
      continue;
    }

    // `podman cp` positionals: a SRC/DEST that is an agent-view absolute path
    // (/root/files/<name>/…, A9) is rewritten to its host path so the host podman can
    // see it; an absolute path outside every grant is denied (same ownership floor as
    // -v). A `container:path` ref (no leading slash) and cp flags pass through. This
    // is verb-scoped to cp so other verbs' absolute positionals are never touched.
    if (verb === "cp" && !tok.startsWith("-") && tok.startsWith("/")) {
      out.push(mapHostPath(p, tok));
      continue;
    }

    // --mount type=bind,source=...: rewrite the source= field (volume verbs only).
    if (base === "--mount" && VOLUME_VERBS.has(verb)) {
      let spec = val;
      let consumedNext = false;
      if (!hasVal) {
        if (i + 1 >= argv.length) throw new DenyError("dangling --mount");
        spec = argv[i + 1];
        consumedNext = true;
      }
      const rw = rewriteMount(p, spec);
      if (hasVal) out.push(`${base}=${rw}`);
      else out.push(base, rw);
      if (consumedNext) i++;
      continue;
    }

    out.push(tok);
  }
  return out;
}

/**
 * Maps an agent's working directory to its host path when it sits under a grant,
 * else null. The broker sets the spawned podman's cwd to this so `cd <project> &&
 * podman compose up` (no -f) resolves the compose file + its relative bind mounts
 * host-side. A cwd outside every grant returns null (run in the broker's default cwd).
 */
export function mapCwdToHost(p: Policy, cwd: string): string | null {
  if (!cwd) return null;
  try {
    return mapHostPath(p, cwd);
  } catch {
    return null;
  }
}

/**
 * Returns the per-agent resource name (A11 namespacing): a stable prefix so one
 * agent's containers/networks/volumes never collide with another's.
 */
export function namespaceName(p: Policy, name: string): string {
  const short = p.guid.length > 12 ? p.guid.slice(0, 12) : p.guid;
  const prefix = `tonoman-${short}-`;
  return name.startsWith(prefix) ? name : prefix + name;
}

// Exported for unit tests of the internal helpers.
export const _internal = { splitFlag, splitVolumeSrc, isNamedVolume, mapHostPath, rewriteVolume, rewriteMount };
