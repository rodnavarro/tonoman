// The LIVE GitAdapter for the learn substrate (learn-durable, Model B: the agent acts as a scoped
// principal with its own credential). Zero-dep: shells `git` and calls the GitHub REST API via fetch.
// The token rides ONLY in the clone/push URL and the API Authorization header — never in a logged
// argv or error message (git failures report the subcommand + exit code, like rn-cli's git.ts).
//
//   personal → clone the agent's OWN brain repo, append the policy file, commit to main, push, SHA
//   shared   → clone config_repo, branch, write the skill, push the branch, open a PR, PR URL
//
// The commit AUTHOR is the agent's identity (e.g. "sapien-agent"), even though the credential is the
// operator's token (ship-now: own footprint, shared identity — see docs/scenarios/contracts/learn-durable.md).

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GitAdapter } from "./learn";

export interface LiveGitOptions {
  /** GitHub token (a podman secret / env). Never logged. */
  token: string;
  /** the commit/PR author — the agent's own identity. */
  author: { name: string; email: string };
  /** owner/name of the org config repo (shared path), parsed from config_repo. */
  configRepo?: { owner: string; name: string };
  /** owner/name of the agent's own brain repo (personal path). */
  brainRepo?: { owner: string; name: string };
  /** the agent's LIVE writable brain checkout (personal path). When set, commitToMain operates
   * IN it (pull → append → commit → push), so the just-learned rule is immediately visible to the
   * runtime's LEARNED.md injection. When unset, it clones to a temp dir (a fresh push, but the live
   * context won't see it until next boot). */
  brainDir?: string;
  /** injectable for tests. */
  fetch?: typeof fetch;
  git?: (args: string[], cwd?: string) => Promise<string>;
}

/** "github.com/example-org/tonoman-config" | "https://github.com/example-org/tonoman-config.git" → {owner,name}. */
export function parseRepo(url: string): { owner: string; name: string } {
  const m = url
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) throw new Error(`learn: cannot parse a GitHub owner/repo from "${url}"`);
  return { owner: m[1], name: m[2] };
}

/** Run git, reporting only the subcommand + exit code on failure (the argv may carry a token URL). */
function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024 }, (err, so) => {
      if (err) reject(new Error(`learn: git ${args.find((a) => !a.startsWith("-")) ?? args[0]} failed (exit ${(err as { code?: number }).code ?? "?"})`));
      else resolve((so ?? "").toString());
    });
  });
}

export function liveGitAdapter(o: LiveGitOptions): GitAdapter {
  const git = o.git ?? runGit;
  const doFetch = o.fetch ?? fetch;
  const cloneUrl = (r: { owner: string; name: string }) => `https://x-access-token:${o.token}@github.com/${r.owner}/${r.name}.git`;
  const authorArgs = ["-c", `user.name=${o.author.name}`, "-c", `user.email=${o.author.email}`];

  return {
    async commitToMain({ file, content, message }) {
      // In-place in the LIVE brain checkout (so the rule is immediately visible), or a temp clone.
      const inPlace = Boolean(o.brainDir);
      if (!inPlace && !o.brainRepo) throw new Error("learn: no brain repo configured for a personal write");
      const dir = inPlace ? o.brainDir! : await fs.mkdtemp(path.join(os.tmpdir(), "tnlearn-"));
      try {
        if (inPlace) await git(["-C", dir, "pull", "--ff-only"]).catch(() => {}); // best-effort freshen
        else await git(["clone", "--depth", "1", cloneUrl(o.brainRepo!), dir]);
        const dest = path.join(dir, file);
        // A policy file is a LOG: append the new entry rather than clobbering prior learnings.
        const prior = await fs.readFile(dest, "utf8").catch(() => "");
        await fs.writeFile(dest, prior ? `${prior.replace(/\s*$/, "")}\n\n${content}\n` : `${content}\n`);
        await git(["-C", dir, "add", file]);
        await git(["-C", dir, ...authorArgs, "commit", "-m", message]);
        // Push to an explicit token URL (never rely on a token baked into the checkout's origin).
        if (o.brainRepo) await git(["-C", dir, "push", cloneUrl(o.brainRepo), "HEAD:main"]);
        else await git(["-C", dir, "push", "origin", "HEAD:main"]);
        return (await git(["-C", dir, "rev-parse", "HEAD"])).trim();
      } finally {
        if (!inPlace) await fs.rm(dir, { recursive: true, force: true });
      }
    },

    async openPr({ branch, path: filePath, content, title, body }) {
      if (!o.configRepo) throw new Error("learn: no config_repo configured for a shared write");
      const { owner, name } = o.configRepo;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnlearn-"));
      try {
        await git(["clone", "--depth", "1", cloneUrl(o.configRepo), dir]);
        await git(["-C", dir, "checkout", "-B", branch]);
        const dest = path.join(dir, filePath);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content.endsWith("\n") ? content : content + "\n");
        await git(["-C", dir, "add", filePath]);
        await git(["-C", dir, ...authorArgs, "commit", "-m", title]);
        await git(["-C", dir, "push", "-f", cloneUrl(o.configRepo), `${branch}:${branch}`]);
        const res = await doFetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
          method: "POST",
          headers: { Authorization: `token ${o.token}`, Accept: "application/vnd.github+json", "User-Agent": "tonoman-learn", "content-type": "application/json" },
          body: JSON.stringify({ title, head: branch, base: "main", body }),
        });
        if (res.status === 422) {
          // A PR from this branch already exists (re-proposed) — find and return it, don't error.
          const existing = await doFetch(`https://api.github.com/repos/${owner}/${name}/pulls?head=${owner}:${branch}&state=open`, {
            headers: { Authorization: `token ${o.token}`, Accept: "application/vnd.github+json", "User-Agent": "tonoman-learn" },
          });
          const arr = (await existing.json().catch(() => [])) as Array<{ html_url?: string }>;
          if (arr[0]?.html_url) return arr[0].html_url;
        }
        if (!res.ok) throw new Error(`learn: GitHub PR create failed (${res.status})`);
        const j = (await res.json()) as { html_url?: string };
        if (!j.html_url) throw new Error("learn: GitHub PR response had no url");
        return j.html_url;
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}
