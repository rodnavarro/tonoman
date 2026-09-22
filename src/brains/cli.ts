// `tonoman` — the one command every agent has in every turn (Tonoman Cloud docs/definition/objects/
// cli.md, D-CAPABILITIES-AS-CLI). It replaces the MCP brain tool: an MCP tool puts its whole schema in
// every model call, a command costs one paragraph and is learned with `--help`.
//
// The script is written to the broker's scratch folder at start (like the MCP shim was) and run by
// the turn's shell. Who it acts for is the turn's token in its environment, checked by the broker on
// every call (CLI-ACTS-AS-SPEAKER); a token whose turn has ended is refused (CLI-DIES-WITH-TURN).

/** What the agent's context says about `tonoman`: one paragraph, however many commands there are
 *  (CLI-SMALL-CONTEXT). */
export const CLI_NOTE = [
  "You have one command-line tool, `tonoman`, and no other program. It reaches the brains this person",
  "can read and write (and, where it is on, Receipts). Run `tonoman --help` to see its groups and",
  "`tonoman <group> --help` for each command's arguments. Start with `tonoman brain list`.",
].join("\n");

/** `tonoman` as ONE MCP tool, for a harness that must not have a shell (Codex): the tool takes the
 *  command's arguments and runs the very same CLI. One short schema, however many commands. */
export const toolShimSource = String.raw`"use strict";
const { execFile } = require("node:child_process");
const tool = {
  name: "tonoman",
  description: "Tonoman's one command. Pass its arguments as a list, e.g. [\"brain\",\"list\"]. Start with [\"--help\"]; [\"<group>\",\"--help\"] lists a group's commands and arguments.",
  inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" } } }, required: ["args"] },
};
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
// A call still running when the harness closes our input is answered before we exit.
let pending = 0, ended = false;
const done = () => { if (ended && pending === 0) process.exit(0); };
const run = (args) => new Promise((resolve) => {
  pending++;
  execFile(process.execPath, [process.env.TONOMAN_CLI_PATH, ...(Array.isArray(args) ? args.map(String) : [])], { env: process.env, timeout: 120000, maxBuffer: 1 << 22 }, (err, so, se) =>
    resolve({ content: [{ type: "text", text: (String(so) + String(se)).trim() || "(no output)" }], isError: !!err }));
});
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tonoman", version: "1" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [tool] } });
    else if (m.method === "tools/call") {
      const result = m.params && m.params.name === "tonoman" ? await run(m.params.arguments && m.params.arguments.args) : { content: [{ type: "text", text: "no such tool" }], isError: true };
      send({ jsonrpc: "2.0", id: m.id, result });
      if (m.params && m.params.name === "tonoman") { pending--; done(); }
    }
    else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
process.stdin.on("end", () => { ended = true; done(); });
`;

export const cliSource = String.raw`"use strict";
const URL_ = process.env.TONOMAN_BRAIN_URL, TOKEN = process.env.TONOMAN_BRAIN_TOKEN;
const RECEIPTS = process.env.TONOMAN_RECEIPTS === "1";
const MAX = 6000; // CLI-OUTPUT-BOUNDED

const GROUPS = {
  brain: {
    about: "the brains this person can reach",
    commands: {
      list: { route: "brain/list", args: [], about: "List the brains this person can reach, whose each is, read or write, and the start of each index.md. Run this first." },
      pages: { route: "brain/pages", args: ["--brain", "[--folder]"], about: "A brain's pages, or a folder's, newest change first (at most 40)." },
      search: { route: "brain/search", args: ["--query", "[--brain]"], about: "Lines containing all the words, across brains or in one." },
      read: { route: "brain/read", args: ["--brain", "--path"], about: "Read one page; prints its revision, to pass back when you edit it." },
      edit: { route: "brain/edit", args: ["--brain", "--path", "--find", "--replace | --after", "[--note]"], about: "Change ONE place in a page or any text file, in place: --find the exact words (enough of the line to be found only once), then --replace them or add --after them. Everything else in the file stays as it is. Use this, not write, to correct or add to a long file such as a ledger or a log. Find the exact text first with search or read." },
      write: { route: "brain/write", args: ["--brain", "--path", "--note", "--content (or the page on stdin)", "[--revision]"], about: "Create or replace one page and commit it. Pass --revision when editing. Also add the page to index.md or its topic's hub." },
    },
  },
  receipts: {
    about: "file receipts and read the year's totals (Receipts Talent)",
    needs: "receipts",
    commands: {
      file: { route: "receipts/file", args: ["--file", "--vendor", "--date YYYY-MM-DD", "--amount", "--category", "--entity", "[--doc-type]", "[--year]", "[--note]", "[--extra]"], about: "File a receipt the person attached (a file in this turn's folder) with its row in the ledger. Every field comes from the document or the person: never guess one — ask. --extra keeps another photo of a receipt already filed: it needs only --file, --vendor, --date and --amount (no category, no entity — it adds no row)." },
      totals: { route: "receipts/totals", args: ["[--year]"], about: "The year's count and totals by category, from the ledger." },
    },
  },
};

const out = (s) => process.stdout.write(s.length > MAX ? s.slice(0, MAX) + "\n… " + (s.length - MAX) + " more characters not shown; narrow the request (a folder, a smaller page).\n" : s.endsWith("\n") ? s : s + "\n");
const fail = (s, code = 1) => { process.stderr.write(s + "\n"); process.exit(code); };
const available = (g) => !GROUPS[g].needs || (GROUPS[g].needs === "receipts" && RECEIPTS);

function help(group) {
  if (!group) {
    const lines = ["tonoman <group> <command> [--arg value …]", ""];
    for (const [g, d] of Object.entries(GROUPS)) if (available(g)) lines.push("  " + g.padEnd(10) + d.about);
    lines.push("", "tonoman <group> --help   the group's commands and their arguments");
    return lines.join("\n");
  }
  const d = GROUPS[group];
  const lines = ["tonoman " + group + " — " + d.about, ""];
  for (const [c, x] of Object.entries(d.commands)) lines.push("  " + c + " " + x.args.join(" "), "      " + x.about);
  return lines.join("\n");
}

function parse(argv) {
  const body = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail("Unexpected '" + a + "'. See tonoman --help.", 2);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) body[key] = true;
    else { body[key] = next; i++; }
  }
  return body;
}

async function stdin() {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}

(async () => {
  const [group, cmd, ...rest] = process.argv.slice(2);
  if (!group || group === "--help" || group === "help") return out(help());
  if (!GROUPS[group]) fail("No command group '" + group + "'. See tonoman --help.", 2);
  if (!available(group)) fail(group === "receipts" ? "Receipts is not on for this agent, so tonoman receipts does nothing here." : "Not available here.", 3);
  if (!cmd || cmd === "--help" || cmd === "help") return out(help(group));
  const spec = GROUPS[group].commands[cmd];
  if (!spec) fail("No command '" + group + " " + cmd + "'. See tonoman " + group + " --help.", 2);
  if (!URL_ || !TOKEN) fail("tonoman is not connected in this turn.", 4);
  const body = parse(rest);
  if (group === "brain" && cmd === "write" && typeof body.content !== "string") body.content = await stdin();
  let r;
  try {
    r = await fetch(URL_ + "/" + spec.route, { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    fail("Tonoman could not be reached just now.", 5);
  }
  const text = await r.text();
  if (!r.ok) { out(text); process.exit(r.status === 401 ? 4 : 1); }
  out(text);
})();
`;
