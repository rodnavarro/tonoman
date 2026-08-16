// Where a conversation lives between restarts, and how to address one by person.
//
// A connector that only remembers conversations in memory can answer, but it can
// never SPEAK FIRST after a restart — and it fails silently, which is the worst
// shape for this: nothing errors, the message simply never arrives. Persisting
// the reference fixes that.
//
// It also changes what a caller has to know. An opaque conversation id is a
// Teams implementation detail; a person is not. Something that wants to tell Rod
// about a finished job should be able to say "rod", not carry a channel id
// around, so the store keeps a person index alongside the conversation one.
import fs from "node:fs";
import path from "node:path";

/** A stored conversation, plus the aliases that resolve to it. */
export interface StoredRef<T = unknown> {
  conversation: string;
  ref: T;
  /** Lowercased aliases: email, display name, aad object id, "rod". */
  aliases: string[];
  updatedAt: string;
}

export interface ConvStoreOptions {
  /** File on the PVC. When absent the store is memory-only — the old behaviour,
   *  which is right for tests and for a connector with nothing to persist. */
  file?: string;
  now?: () => Date;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export class ConvStore<T = unknown> {
  private readonly byConversation = new Map<string, StoredRef<T>>();
  private readonly byAlias = new Map<string, string>(); // alias → conversation
  private readonly file?: string;
  private readonly now: () => Date;

  constructor(opts: ConvStoreOptions = {}) {
    this.file = opts.file;
    this.now = opts.now ?? (() => new Date());
    this.load();
  }

  /** Remember a conversation and everything that names it. */
  put(conversation: string, ref: T, aliases: string[] = []): void {
    const existing = this.byConversation.get(conversation);
    // Aliases accumulate: an early activity may carry an aad id and a later one
    // the resolved email, and losing either would lose a way to address them.
    const merged = new Set<string>(existing?.aliases ?? []);
    for (const a of aliases) {
      const n = norm(a);
      if (n) merged.add(n);
    }
    const entry: StoredRef<T> = {
      conversation,
      ref,
      aliases: [...merged],
      updatedAt: this.now().toISOString(),
    };
    this.byConversation.set(conversation, entry);
    for (const a of entry.aliases) this.byAlias.set(a, conversation);
    this.save();
  }

  get(conversation: string): T | undefined {
    return this.byConversation.get(conversation)?.ref;
  }

  /** Resolve a person to their conversation. Matches an alias exactly, then by
   *  the local part of an email, so "rod" finds rod@example.com. */
  resolve(person: string): StoredRef<T> | undefined {
    const p = norm(person);
    if (!p) return undefined;
    const direct = this.byAlias.get(p);
    if (direct) return this.byConversation.get(direct);
    for (const [alias, conversation] of this.byAlias) {
      if (alias.split("@")[0] === p) return this.byConversation.get(conversation);
    }
    return undefined;
  }

  /** Every known conversation — for diagnostics and for `/health`. */
  all(): StoredRef<T>[] {
    return [...this.byConversation.values()];
  }

  // ---- persistence ---------------------------------------------------
  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredRef<T>[];
      for (const entry of raw) {
        this.byConversation.set(entry.conversation, entry);
        for (const a of entry.aliases ?? []) this.byAlias.set(a, entry.conversation);
      }
    } catch (e) {
      // A corrupt store must not stop the gateway booting: the agent can still
      // answer anyone who writes to it, and the store refills as people do.
      console.error(`convstore: could not read ${this.file}: ${(e as Error).message}`);
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.all(), null, 2), "utf8");
      fs.renameSync(tmp, this.file); // atomic: a crash mid-write cannot truncate it
    } catch (e) {
      console.error(`convstore: could not write ${this.file}: ${(e as Error).message}`);
    }
  }
}
