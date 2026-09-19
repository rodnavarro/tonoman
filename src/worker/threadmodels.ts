// A thread's own model choice (`!model`), per agent (CONVO-EACH-AGENT-ITS-OWN) and per provider
// (INFER-SWITCH-COUNTS-CURRENT).
//
// Keyed by agent as well as conversation because several agents can now answer in one thread: a
// `!model opus` to Echo must not change what Golf runs. And read against the agent's CURRENT
// provider, because a choice made on Claude means nothing on Codex — after a switch the roster's
// model answers until someone picks again.
//
// In memory, like the sessions it sits beside: a restart forgets a thread's choice, and the roster's
// model is the safe default.

import { CODEX_ALIASES } from "../modelcmd";

export type Provider = "claude" | "codex";

/** PURE: which provider a model id belongs to. */
export function providerOfModel(model: string): Provider {
  const m = model.toLowerCase();
  return (CODEX_ALIASES as readonly string[]).includes(m) || m.startsWith("gpt-") ? "codex" : "claude";
}

export function threadModels(): {
  get(agent: string, conversation: string, provider: Provider): string | undefined;
  set(agent: string, conversation: string, model: string | undefined): void;
} {
  const chosen = new Map<string, string>();
  const key = (agent: string, conversation: string): string => `${agent}\u0000${conversation}`;
  return {
    get(agent, conversation, provider) {
      const m = chosen.get(key(agent, conversation));
      return m && providerOfModel(m) === provider ? m : undefined;
    },
    set(agent, conversation, model) {
      if (model) chosen.set(key(agent, conversation), model);
      else chosen.delete(key(agent, conversation));
    },
  };
}

/** Anything an agent keeps for a conversation — its footer mode, its last turn's usage — kept per
 *  AGENT as well as per conversation, so two agents in one thread never share it
 *  (CONVO-EACH-AGENT-ITS-OWN). `idOf` turns an agent's name into its permanent id, so a rename keeps
 *  what it had. */
export function perAgentConversation<T>(idOf: (agent: string) => string): {
  get(agent: string, conversation: string): T | undefined;
  set(agent: string, conversation: string, value: T): void;
} {
  const m = new Map<string, T>();
  const key = (agent: string, conversation: string) => `${idOf(agent)}\u0000${conversation}`;
  return {
    get: (agent, conversation) => m.get(key(agent, conversation)),
    set: (agent, conversation, value) => void m.set(key(agent, conversation), value),
  };
}
