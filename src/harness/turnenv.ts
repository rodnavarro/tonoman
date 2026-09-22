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

/** What a program started as a turn's own user is told OF THE WORKER'S, by name: how this machine is
 *  set up, and nothing else. Everything else of the worker's stays with the worker
 *  (TURNUSER-ONLY-WHAT-IT-NEEDS): removing secret-looking names let through whatever was not named
 *  like a secret — the pool's own Claude login among it, on purpose. */
const CHILD_MAY_KNOW = new Set([
  "PATH", "LANG", "LANGUAGE", "TZ", "TERM", "NO_COLOR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

/** PURE: the environment for a program started as a turn's own user: the machine's settings from the
 *  worker, plus `extra` — what THIS run is given, by whoever starts it: where its login is, the
 *  turn's own credential, a Talent's. A credential is never taken from the worker's environment, only
 *  from `extra`, where it was made for this run. A Bedrock agent cannot run without AWS credentials,
 *  so those come from the worker too — only when the run itself says it is one. */
export function childEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const bedrock = extra.CLAUDE_CODE_USE_BEDROCK === "1";
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (PROXY_NAMES.has(k)) {
      // A proxy's address, never a proxy's password: one written into the address is the worker's.
      if (!hasCredentials(v)) out[k] = v;
    } else if (CHILD_MAY_KNOW.has(k) || k.startsWith("LC_") || (bedrock && BEDROCK_NEEDS.has(k))) out[k] = v;
  }
  return { ...out, ...extra };
}

const PROXY_NAMES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]);
/** What a Bedrock run cannot do without — by name. Not everything called AWS_*: the worker may hold
 *  other AWS settings that are none of a turn's business. */
const BEDROCK_NEEDS = new Set(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK"]);
const hasCredentials = (address: string): boolean => {
  try {
    const u = new URL(address);
    return !!(u.username || u.password);
  } catch {
    return /@/.test(address);
  }
};

/** PURE: what a harness worked out for one run, picked out of the environment it built: its login's
 *  folder and its provider's switches. Passed to `commandFor` as `extra`, so that these — and only
 *  these — reach a program started as a user. The turn's own `tonoman` credential is NOT picked out
 *  of an environment: it is handed over by name, from where it was made for this run (`req.cli.env`,
 *  `mcpEnv`), so one the worker happened to hold can never ride along. */
export function runOnly(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "IS_SANDBOX", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];
  return Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/** The turn's environment with its `tonoman` first on the PATH and this turn's token — which replaces
 *  any other (CLI-ACTS-AS-SPEAKER). */
export function withCli(env: NodeJS.ProcessEnv, cli: { binDir: string; env: Record<string, string> }): NodeJS.ProcessEnv {
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...env, ...cli.env, PATH: [cli.binDir, env.PATH].filter(Boolean).join(sep) };
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
    // The NAMES of what the server needs, never the values: Codex hands it those variables from the
    // turn's own environment (`mcpEnv`). A value here would sit on the command line, where any process
    // on the machine can read it — and one of them is the turn's credential (CLI-TOKEN-NOT-IN-ARGUMENTS).
    out.push("-c", `${key}.env_vars=${JSON.stringify(Object.keys(s.env))}`);
  }
  return out;
}

/** PURE: what those servers need, as environment for the Codex process that starts them. */
export function mcpEnv(servers: McpServer[] | undefined): Record<string, string> {
  return Object.assign({}, ...(servers ?? []).map((s) => s.env));
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
