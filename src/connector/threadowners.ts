// Which agent last answered each thread (CONVO-WHO-IS-ADDRESSED).
//
// A bare `!command` in a thread several agents share belongs to whichever answered there last. The
// worker knows that without asking Slack: every answer an agent posts into a thread passes through its
// connector, which records it here. Reading the thread back from Slack instead cost a call per command,
// saw only the first page of a long thread, and counted every integration bot in it.
//
// One record per worker, shared by every agent it serves; bounded (the threads answered longest ago
// are forgotten first) and kept on disk, so a restart does not forget who was talking. A thread with no
// record is decided by the older rules in the connector.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ThreadOwners {
  /** The bot user id of the agent that last answered this thread, if it is known. */
  get(channel: string, thread: string): string | undefined;
  /** An agent (by its bot user id) just answered in this thread. */
  set(channel: string, thread: string, botUserId: string): void;
  /** Wait for the record to reach disk. */
  flush(): Promise<void>;
}

export function threadOwners(o: { file?: string; max?: number } = {}): ThreadOwners {
  const max = o.max ?? 5_000;
  const map = new Map<string, string>();
  if (o.file) {
    try {
      const saved = JSON.parse(fs.readFileSync(o.file, "utf8")) as [string, string][];
      if (Array.isArray(saved)) for (const [k, v] of saved.slice(-max)) if (typeof k === "string" && typeof v === "string") map.set(k, v);
    } catch {
      /* none yet, or unreadable: start empty rather than stop the worker */
    }
  }
  const key = (channel: string, thread: string) => `${channel}/${thread}`;
  let writing: Promise<void> = Promise.resolve();
  let dirty = false;
  const save = (): void => {
    if (!o.file || dirty) return;
    dirty = true;
    const file = o.file;
    // One write at a time, of whatever the record is by then: a burst of answers is one write.
    writing = writing.then(async () => {
      dirty = false;
      const tmp = `${file}.tmp`;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify([...map]));
      await fs.promises.rename(tmp, file);
    }).catch((e) => console.error(`thread owners: could not save — ${(e as Error).message}`));
  };
  return {
    get: (channel, thread) => map.get(key(channel, thread)),
    set: (channel, thread, botUserId) => {
      if (!channel || !thread || !botUserId) return;
      const k = key(channel, thread);
      map.delete(k); // re-inserted as the newest
      map.set(k, botUserId);
      while (map.size > max) map.delete(map.keys().next().value!);
      save();
    },
    flush: async () => {
      await writing;
    },
  };
}
