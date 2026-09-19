// Where an answer that used a brain may go (BRAIN-AUDIENCE, BRAIN-PRIVATE-DELIVERY, D-PUBLIC-CHANNELS).
//
// The question is asked BEFORE anything of the answer is shown, and it fails closed: if the audience
// cannot be counted in full, it is treated as unable to read any brain, and the answer goes to the
// person privately. Slack's own member list is the only source; a channel-id prefix is not.

export type Audience =
  /** The speaker's own 1:1 DM with the agent. */
  | { kind: "self" }
  /** A private channel or group DM, every member counted (the agent itself left out). */
  | { kind: "members"; members: string[]; name?: string }
  /** A public channel: anyone in the workspace can open it without joining. */
  | { kind: "public"; name?: string }
  /** Could not be counted — a missing permission, a rate limit, a shared channel we cannot see into. */
  | { kind: "unknown"; why: string; name?: string };

export type Route = { to: "thread" } | { to: "private" };

/** PURE: the routing decision. `readableByAll` is what the registry said every member can read. */
export function decideRoute(audience: Audience, used: string[], readableByAll: string[] | null): Route {
  if (used.length === 0) return { to: "thread" };
  if (audience.kind === "self") return { to: "thread" };
  if (audience.kind !== "members" || !readableByAll) return { to: "private" };
  const ok = new Set(readableByAll);
  return used.every((b) => ok.has(b)) ? { to: "thread" } : { to: "private" };
}

/** PURE: the first line of the DM, saying why it arrived there. */
export function privateReason(brainNames: string[], audience: Audience): string {
  const which = brainNames.length ? listOf(brainNames) : "a brain";
  const where = "name" in audience && audience.name ? `#${audience.name}` : "that conversation";
  const why =
    audience.kind === "public"
      ? `${where} is public, so anyone in the workspace could read it there`
      : `not everyone in ${where} can read it`;
  return `_Answering here because part of this comes from ${which}, and ${why}._`;
}

export const THREAD_NOTE = "I've sent you that privately.";
export const THREAD_NOTE_FAILED = "I have an answer, but it draws on a brain not everyone here can read, and I couldn't message you privately. Open a direct message with me and ask again.";

function listOf(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

type Call = <T = unknown>(method: string, body?: Record<string, unknown>) => Promise<T>;

interface ConvInfo {
  channel?: {
    name?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    is_channel?: boolean;
    is_group?: boolean;
    is_ext_shared?: boolean;
    is_shared?: boolean;
    is_org_shared?: boolean;
    is_pending_ext_shared?: boolean;
    user?: string;
  };
}

/** Who will see a reply in this conversation, asked of Slack. Never guesses from an id's prefix. */
export async function audienceOf(call: Call, channel: string, speaker: string, botUserId: string): Promise<Audience> {
  let info: ConvInfo;
  try {
    info = await call<ConvInfo>("conversations.info", { channel });
  } catch (e) {
    return { kind: "unknown", why: (e as Error).message };
  }
  const c = info.channel ?? {};
  const name = c.name;
  if (c.is_im) return c.user === speaker ? { kind: "self" } : { kind: "unknown", why: "someone else's DM", name };
  // Shared with another workspace (Slack Connect, or across an org): the other side may see it
  // differently — public there, say — and its members are not ours to count.
  if (c.is_ext_shared || c.is_shared || c.is_org_shared || c.is_pending_ext_shared) return { kind: "unknown", why: "shared with another workspace", name };
  if (!c.is_mpim && !c.is_private) return { kind: "public", name };
  const members: string[] = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    let r: { members?: string[]; response_metadata?: { next_cursor?: string } };
    try {
      r = await call("conversations.members", { channel, limit: 1000, ...(cursor ? { cursor } : {}) });
    } catch (e) {
      return { kind: "unknown", why: (e as Error).message, name };
    }
    if (!Array.isArray(r.members)) return { kind: "unknown", why: "Slack gave no member list", name };
    members.push(...r.members);
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!cursor) {
      const people = members.filter((m) => m !== botUserId);
      // The person asking must be in the list; if not, the list is not what we think it is.
      if (!people.includes(speaker)) return { kind: "unknown", why: "the member list does not include the speaker", name };
      return { kind: "members", members: people, name };
    }
  }
  return { kind: "unknown", why: "too many members to count", name };
}
