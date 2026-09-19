// Creating a brain's repo on Azure DevOps (D-REPO-PER-BRAIN).
//
// One repo per brain, named `brain-<tenant>-<slug>` with a suffix per environment (`-dev` on the dev
// stack), in one project. A second attempt for the same brain adopts the repo the first one made —
// the registry is only told once the repo exists, so a crash in between must not strand it.

import type { Provisioner, Reachable } from "./broker";

export interface AdoOptions {
  org: string;
  project: string;
  /** Appended to every repo name, e.g. "-dev". */
  suffix?: string;
  pat(): Promise<string>;
  fetchImpl?: typeof fetch;
}

/** PURE: the repo name for a brain: `brain-<tenant>-<slug>-<id>-<suffix>`, within ADO's 64 characters.
 *  The brain's own id and the environment suffix are never cut — only the readable parts shorten — so
 *  two brains can never be given, or adopt, the same repo. */
export function repoName(tenant: string, slug: string, suffix: string, brainId: string): string {
  const clean = (x: string) => x.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const id = brainId.replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase();
  const tail = `-${id}${clean(suffix) ? `-${clean(suffix)}` : ""}`;
  const room = 64 - "brain-".length - tail.length - 1;
  const t = clean(tenant).slice(0, Math.max(4, Math.floor(room / 2)));
  const sl = clean(slug).slice(0, Math.max(4, room - t.length));
  return `brain-${t}-${sl}${tail}`.replace(/-+/g, "-");
}

/** PURE: the clone URL without the username ADO puts in `remoteUrl`, so no identity is stored. */
export function plainRemote(remoteUrl: string): string {
  try {
    const u = new URL(remoteUrl);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return remoteUrl;
  }
}

export function adoProvisioner(o: AdoOptions): Provisioner {
  const f = o.fetchImpl ?? fetch;
  const base = `https://dev.azure.com/${encodeURIComponent(o.org)}`;
  const headers = async () => ({
    authorization: `Basic ${Buffer.from(`:${await o.pat()}`).toString("base64")}`,
    "content-type": "application/json",
  });
  let projectId = "";

  async function project(): Promise<string> {
    if (projectId) return projectId;
    const r = await f(`${base}/_apis/projects/${encodeURIComponent(o.project)}?api-version=7.1`, { headers: await headers() });
    if (!r.ok) throw new Error(`Azure DevOps project "${o.project}" is not reachable (${r.status})`);
    projectId = ((await r.json()) as { id: string }).id;
    return projectId;
  }

  async function existing(name: string): Promise<string | null> {
    const r = await f(`${base}/${encodeURIComponent(o.project)}/_apis/git/repositories/${encodeURIComponent(name)}?api-version=7.1`, {
      headers: await headers(),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`could not look up repo ${name} (${r.status})`);
    return ((await r.json()) as { remoteUrl: string }).remoteUrl;
  }

  return {
    token: () => o.pat(),
    async create(tenant: string, b: Reachable) {
      const name = repoName(tenant, b.slug, o.suffix ?? "", b.id);
      const found = await existing(name);
      if (found) return { repoUrl: plainRemote(found), repoName: name };
      const r = await f(`${base}/${encodeURIComponent(o.project)}/_apis/git/repositories?api-version=7.1`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ name, project: { id: await project() } }),
      });
      if (r.ok) return { repoUrl: plainRemote(((await r.json()) as { remoteUrl: string }).remoteUrl), repoName: name };
      // Lost a race with another worker: adopt what it made.
      const again = await existing(name);
      if (again) return { repoUrl: plainRemote(again), repoName: name };
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      throw new Error(`could not create repo ${name} (${r.status}${r.status === 403 ? ": the credential may not be allowed to create repos" : ""}) ${detail}`);
    },
  };
}
