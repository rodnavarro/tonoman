// A tenant's own skills, from its own repository (SKILL-FROM-YOUR-REPO, SKILL-REPO-TOOLS-IN-TURN,
// SKILL-REPO-TOOL-INFERENCE in Tonoman Cloud's skill.md).
//
// The registry says which of a tenant's skills an agent has, and at which commit of the tenant's
// repository. Here that commit is checked out once, in a folder every turn's user may read and none
// may change; its packages are installed with their install scripts OFF, so nothing of the tenant's
// runs as this worker. A turn then gets each skill's instructions in its guidance, and the
// repository's tools through `tonoman run <tool>` — run by the turn's own `tonoman`, as the turn's
// own user, with the turn's own environment, so a model call a tool makes is on the turn's login.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface RepoSkillSpec {
  name: string;
  repoUrl: string;
  commit: string;
  /** The skill's folder in the repository, e.g. `skills/tax-return-summary`. */
  path: string;
}

export interface RunTool {
  name: string;
  /** The tool's entry script, run with node. */
  script: string;
  about: string;
}

export interface PreparedSkills {
  tools: RunTool[];
  notes: { name: string; body: string }[];
}

type Exec = (cmd: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv }) => Promise<string>;

const realExec: Exec = (cmd, args, o) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { ...o, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).replace(/Authorization: Basic \S+/g, "Authorization: ***").slice(0, 400))) : resolve(stdout),
    ),
  );

/** PURE: a skill's instructions without its frontmatter. */
export function skillBody(md: string): string {
  // Line endings as git checked the file out (CRLF on Windows) never change what the skill says.
  return md.replace(/\r\n/g, "\n").replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, "").trim();
}

/** PURE: the tools a repository declares: its package's `bin`, each a script inside it. */
export function toolsOf(pkg: { bin?: string | Record<string, string>; name?: string; description?: string }, dir: string): RunTool[] {
  const bins = typeof pkg.bin === "string" ? { [pkg.name ?? "tool"]: pkg.bin } : (pkg.bin ?? {});
  return Object.entries(bins)
    .filter(([name, rel]) => /^[a-z0-9][a-z0-9._-]*$/i.test(name) && typeof rel === "string" && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."))
    .map(([name, rel]) => ({ name, script: path.join(dir, rel), about: pkg.description ?? "" }));
}

export function repoSkills(o: { root: string; token: (agentGuid: string) => Promise<string>; exec?: Exec; npm?: string; log?: (s: string) => void }) {
  const exec = o.exec ?? realExec;
  const log = o.log ?? ((s: string) => console.log(s));
  const checkouts = new Map<string, Promise<string>>();

  /** The repository at this commit, checked out and its packages installed, once. */
  function checkout(agentGuid: string, repoUrl: string, commit: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) return Promise.reject(new Error(`not a commit: ${commit}`));
    const dir = path.join(o.root, commit.toLowerCase());
    const had = checkouts.get(dir);
    if (had) return had;
    const made = (async () => {
      if (await fs.stat(path.join(dir, ".tonoman-ready")).then(() => true, () => false)) return dir;
      const token = await o.token(agentGuid);
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME ?? "/root",
        GIT_TERMINAL_PROMPT: "0",
        ...(token
          ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }
          : {}),
      };
      const tmp = `${dir}.part-${process.pid}`;
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.mkdir(tmp, { recursive: true });
      await exec("git", ["init", "-q"], { cwd: tmp, env });
      await exec("git", ["fetch", "-q", "--depth", "1", repoUrl, commit], { cwd: tmp, env });
      await exec("git", ["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], { cwd: tmp, env });
      await fs.rm(path.join(tmp, ".git"), { recursive: true, force: true });
      if (await fs.stat(path.join(tmp, "package.json")).then(() => true, () => false)) {
        const lock = await fs.stat(path.join(tmp, "package-lock.json")).then(() => true, () => false);
        // Install scripts OFF: nothing of the tenant's runs as this worker.
        await exec(o.npm ?? "npm", [lock ? "ci" : "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tmp, env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/root" } });
      }
      // Every turn's user may read and run it; none may change it.
      await exec("chmod", ["-R", "a+rX,go-w", tmp], { env: { PATH: process.env.PATH } }).catch(() => "");
      await fs.writeFile(path.join(tmp, ".tonoman-ready"), commit);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(tmp, dir);
      log(`skills: ${repoUrl.replace(/^https?:\/\/[^/]+\//, "")} @ ${commit.slice(0, 12)} ready`);
      return dir;
    })();
    checkouts.set(dir, made);
    made.catch(() => checkouts.delete(dir));
    return made;
  }

  return {
    /** What a turn of this agent gets from its tenant's skills: each skill's instructions, and the tools
     *  of the repositories they come from. A skill that cannot be prepared is left out and said in the
     *  log; the turn goes on without it rather than not at all. */
    async prepare(agentGuid: string, specs: RepoSkillSpec[] | undefined): Promise<PreparedSkills> {
      const out: PreparedSkills = { tools: [], notes: [] };
      for (const s of specs ?? []) {
        try {
          const dir = await checkout(agentGuid, s.repoUrl, s.commit);
          const md = await fs.readFile(path.join(dir, s.path, "SKILL.md"), "utf8");
          out.notes.push({ name: s.name, body: skillBody(md) });
          const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8").catch(() => "{}")) as Parameters<typeof toolsOf>[0];
          for (const t of toolsOf(pkg, dir)) if (!out.tools.some((x) => x.name === t.name)) out.tools.push(t);
        } catch (e) {
          log(`skills: ${s.name} could not be prepared for ${agentGuid} — ${(e as Error).message}`);
        }
      }
      return out;
    },
  };
}
