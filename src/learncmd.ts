// `tonoman learn` — the agent-facing surface of the learn substrate (learn-durable, Model B). Shipped
// in every agent image; the agent runs it IN-PROCESS to persist a learning to the right git:
//
//   tonoman learn --scope personal --reason "<why>" (--content "<text>" | --content-file <path>)
//   tonoman learn --scope shared --skill <name> --reason "<why>" --content-file <new SKILL.md>
//
// Config comes from the agent's OWN env (nothing from the gateway): GITHUB_TOKEN (credential),
// TONOMAN_CONFIG_REPO (the shared registry), TONOMAN_BRAIN_REPO (its own brain), and the commit
// author (LEARN_AUTHOR_NAME/EMAIL — the agent's identity). Prints a JSON receipt the agent relays.

import { promises as fs } from "node:fs";
import { persist, type PersistRequest, type PersistDeps } from "./learn";
import { liveGitAdapter, parseRepo } from "./learn-git";

export interface LearnArgs {
  scope: "personal" | "shared";
  skill?: string; // shared: the target skill under config_repo/skills
  file?: string; // personal: the target policy file (default LEARNED.md)
  content?: string; // inline content
  contentFile?: string; // path to a file holding the content
  reason: string;
}

/** Pure flag parser (unit-tested). Throws a usage Error on a missing/invalid flag. */
export function parseLearnArgs(args: string[]): LearnArgs {
  const o: Partial<LearnArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`learn: ${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--scope": {
        const v = next();
        if (v !== "personal" && v !== "shared") throw new Error(`learn: --scope must be personal|shared (got "${v}")`);
        o.scope = v;
        break;
      }
      case "--skill": o.skill = next(); break;
      case "--file": o.file = next(); break;
      case "--content": o.content = next(); break;
      case "--content-file": o.contentFile = next(); break;
      case "--reason": o.reason = next(); break;
      default:
        throw new Error(`learn: unknown flag "${a}"`);
    }
  }
  if (!o.scope) throw new Error("learn: --scope is required (personal|shared)");
  if (!o.reason) throw new Error("learn: --reason is required (a one-line why)");
  if (o.scope === "shared" && !o.skill) throw new Error("learn: --scope shared needs --skill <name>");
  if (o.content === undefined && o.contentFile === undefined) throw new Error("learn: provide --content or --content-file");
  return o as LearnArgs;
}

/** Run `tonoman learn`. `deps` is injectable for tests; live runs read env + git. */
export async function runLearn(
  args: string[],
  overrides?: { env?: NodeJS.ProcessEnv; persistDeps?: PersistDeps; out?: (s: string) => void },
): Promise<void> {
  const env = overrides?.env ?? process.env;
  const out = overrides?.out ?? ((s: string) => process.stdout.write(s));
  const a = parseLearnArgs(args);
  const content = a.content ?? (await fs.readFile(a.contentFile!, "utf8"));

  let deps = overrides?.persistDeps;
  if (!deps) {
    // Trim: a secret injected via a file/pipe can carry a trailing newline (e.g. podman secret from a
    // PowerShell pipe), which would corrupt the clone URL / auth header. A token never has whitespace.
    const token = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
    if (!token) throw new Error("learn: no GITHUB_TOKEN in the agent environment");
    const configRepoUrl = env.TONOMAN_CONFIG_REPO;
    const brainRepoUrl = env.TONOMAN_BRAIN_REPO;
    const git = liveGitAdapter({
      token,
      author: {
        name: env.LEARN_AUTHOR_NAME || `${env.AGENT_NAME || "tonoman"}-agent`,
        email: env.LEARN_AUTHOR_EMAIL || `${env.AGENT_NAME || "tonoman"}-agent@tonoman.local`,
      },
      configRepo: configRepoUrl ? parseRepo(configRepoUrl) : undefined,
      brainRepo: brainRepoUrl ? parseRepo(brainRepoUrl) : undefined,
      brainDir: env.TONOMAN_BRAIN_DIR, // the live writable brain checkout (personal path, in-place)
    });
    deps = { git, configRepo: configRepoUrl };
  }

  const req: PersistRequest = {
    scope: a.scope,
    target: a.scope === "shared" ? a.skill : a.file,
    content,
    reason: a.reason,
  };
  const receipt = await persist(req, deps);
  out(JSON.stringify({ ok: true, ...receipt }) + "\n");
}
