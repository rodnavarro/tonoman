// Saying something in a CHANNEL a Talent's settings name (DROPS-IN-A-CHANNEL in Tonoman Cloud).
//
// A setting holds what a person typed: a channel's id (`C0ABC1234`), or its name with or without the
// `#`. Slack posts to ids only, so a name is looked up — among the channels the agent can see — and
// remembered. What is NOT done here is treat the value as a person: the first version of the drop
// watcher handed its channel to `say`, which opens a DM with whoever it is given, and every drop
// for a channel went nowhere without a word in the log.

/** A Slack call, as the connector makes it. */
export type SlackCall = <T = unknown>(method: string, body?: Record<string, unknown>) => Promise<T>;

const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;

/** What a setting names: a channel id as it is, else a bare lower-case name. Undefined for nothing. */
export function channelRef(raw: string): { id: string } | { name: string } | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (CHANNEL_ID.test(v)) return { id: v };
  const name = v.replace(/^#/, "").trim().toLowerCase();
  return name ? { name } : undefined;
}

interface ListPage {
  ok?: boolean;
  channels?: { id: string; name: string }[];
  response_metadata?: { next_cursor?: string };
}

/** The id of the channel a setting names, or undefined when the agent can see none by that name.
 *  Public and private alike; archived ones are not offered. Bounded: twenty pages, then it gives up. */
export async function channelIdOf(call: SlackCall, raw: string): Promise<string | undefined> {
  const ref = channelRef(raw);
  if (!ref) return undefined;
  if ("id" in ref) return ref.id;
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const r = await call<ListPage>("conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
    const hit = (r.channels ?? []).find((c) => c.name === ref.name);
    if (hit) return hit.id;
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!cursor) return undefined;
  }
  return undefined;
}

/** Resolves names once and keeps them: a drop must not wait on a directory listing every time. A
 *  name that was NOT found is not kept, so a channel made a minute later is found on the next try. */
export function channelResolver(): (agent: string, call: SlackCall, raw: string) => Promise<string | undefined> {
  const known = new Map<string, string>();
  return async (agent, call, raw) => {
    const key = `${agent}\0${raw.trim().toLowerCase()}`;
    const hit = known.get(key);
    if (hit) return hit;
    const id = await channelIdOf(call, raw);
    if (id) known.set(key, id);
    return id;
  };
}
