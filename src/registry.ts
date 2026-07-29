// Tonoman's local record of running agent *instances* (A11), keyed by GUID — the
// agent's stable identity — stored as a single JSON file (agents.json) under the
// Tonoman state root. Tonoman never inspects an agent's config-volume contents;
// only this registry. The GUID is the join key across config, memory, and messaging.

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

/** One instance row. Metadata only — never the volume's contents (A11). */
export interface Agent {
  guid: string;
  name: string;
  role?: string;
  harness: string;
  model?: string;
  /** auth backend default (backend-*): "subscription" | "bedrock"; the gateway's knob flips it live. */
  backend?: "subscription" | "bedrock";
  max_turns?: number; // per-turn agentic-loop cap (claude-code --max-turns)
  /** status-line footer default (gw-command-statusline): "none" | "small" | "full"; /statusline flips it live. */
  statusline?: "none" | "small" | "full";
  container: string;
  config_volume: string;
  config_home: string;
  memory_root: string;
  channel?: string;
  port_base?: number;
}

/** A short random hex identity. 8 bytes (16 hex chars) is plenty for a local roster. */
export function newGUID(): string {
  return randomBytes(8).toString("hex");
}

/** The on-disk agents.json. */
export class Store {
  constructor(public readonly path: string) {}

  /** Reads the registry, returning [] if the file does not exist. */
  async load(): Promise<Agent[]> {
    let b: string;
    try {
      b = await fs.readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`registry: read ${this.path}: ${(e as Error).message}`);
    }
    if (b.trim() === "") return [];
    return JSON.parse(b) as Agent[];
  }

  /** Writes the registry atomically (write-temp-then-rename), sorted for a stable file. */
  async save(agents: Agent[]): Promise<void> {
    const sorted = [...agents].sort((a, b) => (a.name !== b.name ? a.name.localeCompare(b.name) : a.guid.localeCompare(b.guid)));
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(sorted, null, 2), "utf8");
    await fs.rename(tmp, this.path);
  }

  /** Inserts or replaces an agent by GUID and persists the registry. */
  async upsert(a: Agent): Promise<void> {
    const agents = await this.load();
    const idx = agents.findIndex((x) => x.guid === a.guid);
    if (idx >= 0) agents[idx] = a;
    else agents.push(a);
    await this.save(agents);
  }
}

/** Returns the first agent with the given name. Keeps a config agent's GUID — and
 * therefore its volume/memory paths — stable across restarts when not pinned. */
export function findByName(agents: Agent[], name: string): Agent | undefined {
  return agents.find((a) => a.name === name);
}
