// The registry's brain routes, as the worker calls them (Tonoman Cloud, system token).

import type { BrainsRegistry, Reach } from "./broker";

export function registryClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): BrainsRegistry & {
  readableByAll(agentGuid: string, brainIds: string[], slackUserIds: string[]): Promise<string[]>;
  /** With nobody speaking: the agent's grants and the brains of the person a run is for (BRAIN-UNATTENDED-REACH). */
  reachUnattended(agentGuid: string, forSlackUserId: string | null): Promise<{ tenant: string; brains: Reach["brains"] }>;
  /** What a refresh did (BRAIN-BACKGROUND-REFRESH). */
  publishIndex(brainId: string, body: Record<string, unknown>): Promise<void>;
  /** False only when the registry says the brain is archived (BRAIN-ARCHIVED-ON-LEAVE). A registry
   *  that cannot say — unreachable, or older than this route — does not stop a refresh: the refresh
   *  writes only into that brain's own repo and publishes only to people who reach it. */
  brainActive(brainId: string): Promise<boolean>;
} {
  const call = async <T>(method: string, pathname: string, body: unknown): Promise<T> => {
    const r = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`registry ${pathname}: ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    reach: (agentGuid, slackUserId) => call<Reach>("POST", `/v1/system/agents/${encodeURIComponent(agentGuid)}/brain-reach`, { slackUserId }),
    recordRepo: async (brainId, repoUrl, repoName) => {
      await call("PUT", `/v1/system/brains/${encodeURIComponent(brainId)}/repo`, { repoUrl, repoName });
    },
    publishIndex: async (brainId, body) => {
      await call("PUT", `/v1/system/brains/${encodeURIComponent(brainId)}/index`, body);
    },
    brainActive: async (brainId) => {
      const r = await fetchImpl(`${baseUrl}/v1/system/brains/${encodeURIComponent(brainId)}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      if (!r?.ok) return true;
      const b = (await r.json().catch(() => ({}))) as { state?: string; brain?: { state?: string } };
      return (b.state ?? b.brain?.state) !== "archived";
    },
    reachUnattended: (agentGuid, forSlackUserId) =>
      call<{ tenant: string; brains: Reach["brains"] }>("POST", `/v1/system/agents/${encodeURIComponent(agentGuid)}/brain-reach-unattended`, { forSlackUserId }),
    readableByAll: async (agentGuid, brainIds, slackUserIds) =>
      (await call<{ readableByAll: string[] }>("POST", `/v1/system/agents/${encodeURIComponent(agentGuid)}/brain-audience`, { brainIds, slackUserIds })).readableByAll,
  };
}
