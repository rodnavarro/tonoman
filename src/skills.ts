// Skill assembly (learn-durable read-side). An agent's skill set comes from TWO sources, merged into
// one directory the harness reads:
//
//   platform (baked into the tonoman image)  → e.g. `tonoman-self`: how any agent operates itself.
//                                               A tonoman PRODUCT capability — universal, every org.
//   org registry (<org>/tonoman-config)      → the customer's domain skills (finance, wiki, …),
//                                               each self-contained: SKILL.md + scripts/ (+ a root lib/).
//
// The runtime symlinks each skill into the target skills dir, and each skill's scripts/* onto PATH
// (via binDir), so a skill's deterministic tools are callable by name (kubectl-style: `finance receipt …`)
// and shareable across skills. Editing a source file stays live (symlinks point at the real files).
// Cloud clones the registry; local mounts a host checkout — either way this assembles the same shape.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface AssembleOptions {
  /** where the harness reads skills, e.g. /root/.claude/skills. Rebuilt (our symlinks cleared) each call. */
  target: string;
  /** baked platform skills dir (image), e.g. /opt/tonoman/skills. Optional. */
  platformDir?: string;
  /** org registry skills dir, e.g. /root/registry/skills (mounted) or a clone. Optional. */
  registryDir?: string;
  /** dir on PATH to expose each skill's scripts, e.g. /usr/local/bin. Optional (no scripts exposed if unset). */
  binDir?: string;
  /** the registry's shared lib dir (e.g. /root/registry/lib): CLIs any skill calls (like `rn`). Each
   * `lib/<tool>/` is exposed on PATH by its package.json `bin` (or a cli.js/cli.mjs). Requires binDir. */
  libDir?: string;
  /** when set, only these registry skills are loaded (assignment filter). Undefined = all registry skills. */
  assigned?: string[];
}

export interface AssembleResult {
  skills: string[]; // assembled skill names (platform first, then registry)
  scripts: string[]; // script basenames exposed on PATH
}

async function listDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
}

/** Link a skill DIRECTORY at `link` → `dest`, replacing any existing entry (idempotent). Uses a
 * junction so it needs no privilege on Windows; on Linux the type arg is ignored (a normal symlink). */
async function relinkDir(link: string, dest: string): Promise<void> {
  await fs.rm(link, { recursive: true, force: true }).catch(() => {});
  await fs.symlink(dest, link, "junction");
}

/** Expose a script FILE on PATH at `link` → `dest`. Prefers a symlink (so an edit stays live); falls
 * back to a copy where file symlinks need privilege (Windows without dev mode). */
async function relinkFile(link: string, dest: string): Promise<void> {
  await fs.rm(link, { force: true }).catch(() => {});
  try {
    await fs.symlink(dest, link, "file");
  } catch {
    await fs.copyFile(dest, link);
  }
}

/** Assemble the agent's skills from the platform + registry sources. Idempotent: safe to call on every
 * boot / reload. Only OUR symlinks in `target` are cleared; real subdirectories are left untouched. */
export async function assembleSkills(o: AssembleOptions): Promise<AssembleResult> {
  await fs.mkdir(o.target, { recursive: true });
  // Clear stale symlinks we own (a removed/reassigned skill shouldn't linger).
  for (const name of await fs.readdir(o.target).catch(() => [])) {
    const p = path.join(o.target, name);
    const st = await fs.lstat(p).catch(() => null);
    if (st?.isSymbolicLink()) await fs.rm(p, { force: true }).catch(() => {});
  }
  if (o.binDir) await fs.mkdir(o.binDir, { recursive: true }).catch(() => {});

  const skills: string[] = [];
  const scripts: string[] = [];

  const load = async (srcDir: string | undefined, filter?: string[]): Promise<void> => {
    if (!srcDir) return;
    for (const name of await listDirs(srcDir)) {
      if (filter && !filter.includes(name)) continue;
      await relinkDir(path.join(o.target, name), path.join(srcDir, name));
      skills.push(name);
      // Expose this skill's scripts on PATH so `SKILL.md` can call them by name.
      if (o.binDir) {
        const scriptsDir = path.join(srcDir, name, "scripts");
        for (const s of await fs.readdir(scriptsDir).catch(() => [])) {
          const real = path.join(scriptsDir, s);
          const st = await fs.stat(real).catch(() => null);
          if (!st?.isFile()) continue;
          await fs.chmod(real, 0o755).catch(() => {});
          await relinkFile(path.join(o.binDir, s.replace(/\.(mjs|js)$/, "")), real);
          scripts.push(s);
        }
      }
    }
  };

  await load(o.platformDir); // platform first (product capability)
  await load(o.registryDir, o.assigned); // then the org's assigned domain skills

  // Expose the registry's shared lib CLIs on PATH (e.g. `rn`), so a skill's SKILL.md can call them by
  // name and any skill can share them. Each lib/<tool>/ declares its command via package.json `bin`.
  if (o.libDir && o.binDir) {
    for (const tool of await listDirs(o.libDir)) {
      const toolDir = path.join(o.libDir, tool);
      let bins: Record<string, string> = {};
      const pkg = await fs.readFile(path.join(toolDir, "package.json"), "utf8").then((s) => JSON.parse(s)).catch(() => null);
      if (pkg && typeof pkg.bin === "object") bins = pkg.bin;
      else if (pkg && typeof pkg.bin === "string") bins = { [tool]: pkg.bin };
      else {
        for (const c of ["cli.mjs", "cli.js"]) if (await fs.stat(path.join(toolDir, c)).then(() => true).catch(() => false)) { bins = { [tool]: c }; break; }
      }
      for (const [name, rel] of Object.entries(bins)) {
        const real = path.join(toolDir, rel);
        if (!(await fs.stat(real).then((s) => s.isFile()).catch(() => false))) continue;
        await fs.chmod(real, 0o755).catch(() => {});
        await relinkFile(path.join(o.binDir, name), real);
        scripts.push(name);
      }
    }
  }
  return { skills, scripts };
}

/** Minimal parse of assignments.yaml (`assignments:\n  <agent>:\n    - <skill>`) → the skills for `agent`.
 * Zero-dep and format-specific (no YAML lib); returns undefined if the agent isn't listed (→ load all). */
export function parseAssignments(yaml: string, agent: string): string[] | undefined {
  const lines = yaml.split(/\r?\n/);
  let inAssignments = false;
  let agentIndent = -1;
  const out: string[] = [];
  let found = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (/^assignments\s*:/.test(line)) { inAssignments = true; continue; }
    if (!inAssignments) continue;
    const indent = line.length - line.trimStart().length;
    const agentMatch = line.match(/^(\s*)([A-Za-z0-9._-]+)\s*:\s*$/);
    if (agentMatch && (agentIndent < 0 || indent <= agentIndent)) {
      // a new agent key
      if (agentMatch[2] === agent) { found = true; agentIndent = indent; }
      else if (found) break; // moved past our agent's block
      else agentIndent = indent;
      continue;
    }
    if (found) {
      const item = line.match(/^\s*-\s*([A-Za-z0-9._-]+)/);
      if (item) out.push(item[1]);
    }
  }
  return found ? out : undefined;
}
