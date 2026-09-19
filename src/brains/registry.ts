// The registry's brain routes, as the worker calls them (Tonoman Cloud, system token).

import type { BrainsRegistry, Reach } from "./broker";

export function registryClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): BrainsRegistry & {
  readableByAll(agentGuid: string, brainIds: string[], slackUserIds: string[]): Promise<string[]>;
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
    readableByAll: async (agentGuid, brainIds, slackUserIds) =>
      (await call<{ readableByAll: string[] }>("POST", `/v1/system/agents/${encodeURIComponent(agentGuid)}/brain-audience`, { brainIds, slackUserIds })).readableByAll,
  };
}
