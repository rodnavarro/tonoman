// What a person sent earlier in a conversation, kept so a later turn can still file it
// (CONVO-SENT-FILES-STAY in Tonoman Cloud's conversation.md).
//
// A receipt is rarely one message: the person sends a photo, the agent asks what it was for, and the
// answer arrives with no photo on it. The filing happens on that second turn, so the first turn's
// files have to still be there — as they arrived, since what is filed is what was sent
// (RECEIPT-FILES-WHAT-WAS-SENT). They are kept on the worker's own state, never in a turn's folder:
// one person's, in one conversation, with one agent; a few of them, for a day.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SentFile {
  name: string;
  bytes: Buffer;
}

export interface SentFiles {
  /** Keep what this person just sent in this conversation. */
  keep(agent: string, conversation: string, user: string, files: SentFile[]): Promise<void>;
  /** What they sent here lately, oldest first, each under a name of its own. */
  recent(agent: string, conversation: string, user: string): Promise<SentFile[]>;
}

const KEEP = 8;
const FOR_MS = 24 * 60 * 60 * 1000;

/** A name no file in this list has yet: `receipt.jpg`, then `receipt-2.jpg`, `receipt-3.jpg`. */
export function ownName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
}

export function sentFiles(root: string, now: () => number = Date.now): SentFiles {
  // Every part of the key arrives over the wire, so the folder is a digest of it: it cannot name a
  // path, and it says nothing about who or where to someone listing the volume.
  const folder = (agent: string, conversation: string, user: string): string =>
    path.join(root, createHash("sha256").update(`${agent}\0${conversation}\0${user}`).digest("hex").slice(0, 32));

  const load = async (dir: string): Promise<{ name: string; file: string; at: number }[]> => {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8")) as { name: string; file: string; at: number }[];
      return Array.isArray(j) ? j.filter((e) => e && typeof e.name === "string" && /^[0-9a-f]{16}$/.test(e.file) && typeof e.at === "number") : [];
    } catch {
      return [];
    }
  };

  /** Drop what is too old or past the last few, from the index and from disk. */
  const prune = async (dir: string, entries: { name: string; file: string; at: number }[]) => {
    const fresh = entries.filter((e) => now() - e.at < FOR_MS).slice(-KEEP);
    for (const e of entries) if (!fresh.includes(e)) await fs.rm(path.join(dir, e.file), { force: true }).catch(() => {});
    return fresh;
  };

  return {
    async keep(agent, conversation, user, files) {
      if (!files.length) return;
      const dir = folder(agent, conversation, user);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      let entries = await load(dir);
      for (const f of files) {
        const file = createHash("sha256").update(f.bytes).update(String(now())).update(f.name).digest("hex").slice(0, 16);
        // The name the agent sees, with nothing of a path in it.
        const plain = path.basename(f.name.replace(/\\/g, "/")) || "file";
        const name = ownName(plain, new Set(entries.map((e) => e.name)));
        await fs.writeFile(path.join(dir, file), f.bytes, { mode: 0o600 });
        entries.push({ name, file, at: now() });
      }
      entries = await prune(dir, entries);
      await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(entries), { mode: 0o600 });
    },

    async recent(agent, conversation, user) {
      const dir = folder(agent, conversation, user);
      const entries = await load(dir);
      if (!entries.length) return [];
      const fresh = await prune(dir, entries);
      if (fresh.length !== entries.length) await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(fresh), { mode: 0o600 }).catch(() => {});
      const out: SentFile[] = [];
      for (const e of fresh) {
        const bytes = await fs.readFile(path.join(dir, e.file)).catch(() => null);
        if (bytes) out.push({ name: e.name, bytes });
      }
      return out;
    },
  };
}
