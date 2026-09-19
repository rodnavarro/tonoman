// What a conversation turn's harness is given, and what it is not.
//
// Turns share the worker's filesystem and user for now (D-SHARED-FILESYSTEM in Tonoman Cloud; the real
// fix is a pod per conversation). Within that, a turn gets: its own working folder, an environment
// with the worker's secrets taken out, and the brain tool as its only way into brains. A Codex turn
// has a shell, so what is NOT in its environment is what it cannot read from `env`.

import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Variables a harness needs even though their names look secret. */
const KEEP = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** PURE: the environment with anything secret-shaped removed. The system token, the runtime and wake
 *  tokens, provider API keys and database URLs all match; so does anything a deployer adds later with
 *  a secret-looking name. `keep` lets a caller pass through what a backend genuinely needs. */
export function scrubEnv(base: NodeJS.ProcessEnv, keep: (name: string) => boolean = () => false): NodeJS.ProcessEnv {
  const secret = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|DATABASE_URL|_DSN$|WEBHOOK)/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (secret.test(k) && !KEEP.has(k) && !keep(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface McpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Write the turn's MCP configuration into its own folder and return the path. Claude Code reads it
 *  with `--mcp-config`; it holds this turn's broker token, which opens nothing beyond this turn. */
export async function writeMcpConfig(dir: string, servers: McpServer[]): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, ".mcp-tonoman.json");
  const mcpServers = Object.fromEntries(servers.map((s) => [s.name, { type: "stdio", command: s.command, args: s.args, env: s.env }]));
  await fs.writeFile(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return file;
}

/** PURE: the same servers as Codex `-c` overrides. Values are JSON, which TOML reads as basic strings,
 *  arrays and inline tables. */
export function codexMcpOverrides(servers: McpServer[]): string[] {
  const out: string[] = [];
  const bare = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
  for (const s of servers) {
    const key = `mcp_servers.${bare(s.name)}`;
    out.push("-c", `${key}.command=${JSON.stringify(s.command)}`);
    out.push("-c", `${key}.args=${JSON.stringify(s.args)}`);
    const env = Object.entries(s.env).map(([k, v]) => `${bare(k)}=${JSON.stringify(v)}`).join(",");
    out.push("-c", `${key}.env={${env}}`);
  }
  return out;
}

/** Deny rules for Claude Code's file tools, always added to a full turn. Read rules cover Read,
 *  Grep and Glob. They keep the model's own tools out of brains, credentials and other people's
 *  histories; they are not an OS boundary (that is the pod-per-conversation work). */
export const FILE_DENY_RULES = [
  "Read(//root/.tonoman/**)",
  "Read(//root/.claude/**)",
  "Read(//root/.codex/**)",
  "Read(//etc/tonoman/**)",
  "Read(//proc/**)",
];
