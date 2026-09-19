// Markdown → Slack mrkdwn.
//
// Slack is not a markdown renderer. It has its own dialect where bold is `*one asterisk*`, italic
// is `_underscore_`, strikethrough is `~one tilde~`, and a link is `<url|text>`. The model writes
// GitHub-flavoured markdown, so every `**bold**` it produced arrived on screen as literal asterisks
// — which reads as the agent not knowing how to format, in a client that supports rich text fine.
//
// PURE and total: anything it does not recognise passes through untouched, because mangling an
// answer is worse than leaving one heading un-bolded.
//
// The rule that matters more than the others: NOTHING inside code is transformed. A shell snippet
// containing `**` or `[x](y)` is code, not emphasis, and rewriting it would corrupt the very thing
// somebody is about to copy and run.

/** Sentinels for text already converted, so a later pass cannot convert it again. Control
 *  characters, because any printable marker is something a real message could contain. Both are
 *  removed before this module returns. */
const BOLD_OPEN = "\u0000";
const BOLD_CLOSE = "";

/** Everything that must survive verbatim: fenced blocks, inline code, and anything already in
 *  Slack's own angle-bracket form (whose URLs can contain `*` and `_`). */
const PROTECTED = /(```[\s\S]*?```|`[^`\n]+`|<[^<>\n]+>)/g;

/** A cell's text, stripped of the emphasis a code block would only show as literal asterisks,
 *  and of link syntax (the URL has nowhere to go inside monospace). `\|` unescapes to a pipe. */
function cleanCell(c: string): string {
  return c
    .trim()
    .replace(/\\\|/g, "|")
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1")
    .replace(/__(\S(?:.*?\S)?)__/g, "$1")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1");
}

/** Split one table row into cells: drop the optional border pipes, split on unescaped pipes. */
function splitRow(line: string, cols?: number): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const cells = t.split(/(?<!\\)\|/).map(cleanCell);
  if (cols !== undefined) {
    while (cells.length < cols) cells.push("");
    cells.length = cols;
  }
  return cells;
}

/** A GitHub table's second line: only pipes/dashes/colons, at least one of each (so a `---`
 *  horizontal rule, which has no pipe, is not mistaken for a one-column table), every cell a
 *  run of dashes with optional alignment colons. */
function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  if (!/^[\s|:-]+$/.test(t)) return false;
  return splitRow(t).every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Render a parsed table as an aligned, monospace ASCII table. Slack has no table syntax, so a
 *  code block — the one place it renders monospace — is where columns can line up. */
function renderTable(rows: string[][]): string {
  // Two columns are the label→value case (a benchmark list, a spec sheet). Those render as a
  // bold-label list, NOT a code block: a monospace block wraps on Slack mobile and loses the very
  // alignment that justified it, whereas `*Label:* value` wraps cleanly at any width. The header
  // row is dropped — the labels are self-describing. Three or more columns are a real grid with no
  // list form, so they keep the aligned block (mobile scrolls it).
  if (rows[0]!.length === 2) {
    return rows
      .slice(1)
      .map(([k, v]) => `**${k}:** ${v ?? ""}`.replace(/\s+$/, ""))
      .join("\n");
  }
  const cols = rows[0]!.length;
  const width = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const line = (r: string[]) => r.map((cell, c) => pad(cell ?? "", width[c]!)).join(" | ").replace(/\s+$/, "");
  const divider = width.map((w) => "-".repeat(w)).join("-+-");
  return "```\n" + [line(rows[0]!), divider, ...rows.slice(1).map(line)].join("\n") + "\n```";
}

/** Turn every GitHub markdown table in a segment into a fenced, monospace-aligned code block.
 *  PURE: text with no table comes back untouched. Runs only on non-code segments (see toMrkdwn),
 *  so a table written *inside* a code block is left verbatim like any other code. */
function tablesToCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    const delim = lines[i + 1];
    if (delim !== undefined && header.includes("|") && isDelimiterRow(delim)) {
      const headerCells = splitRow(header);
      if (headerCells.length && splitRow(delim).length === headerCells.length) {
        const rows: string[][] = [headerCells];
        let j = i + 2;
        for (; j < lines.length; j++) {
          const row = lines[j]!;
          if (!row.trim() || !row.includes("|")) break;
          rows.push(splitRow(row, headerCells.length));
        }
        out.push(renderTable(rows));
        i = j - 1;
        continue;
      }
    }
    out.push(header);
  }
  return out.join("\n");
}

function convertSegment(s: string): string {
  return (
    s
      // Headings have no equivalent, so they become bold — the hierarchy is lost but the emphasis
      // survives, which is the part a reader is actually using.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
      // Bold first, and to a sentinel: converting it straight to `*text*` would then look exactly
      // like markdown italic to the next pass, which would turn it into `_text_`.
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
      .replace(/__(?=\S)([^\n_]+?)(?<=\S)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
      // Markdown's `*italic*` is Slack's `_italic_`. Anchored to word boundaries so a stray
      // asterisk — a footnote marker, a glob, a multiplication sign — is left alone.
      .replace(/(^|[\s([{"'])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=[\s)\]}"'.,!?;:]|$)/g, "$1_$2_")
      .replace(/~~(?=\S)([^\n~]+?)(?<=\S)~~/g, "~$1~")
      // `[text](url)` → `<url|text>`. Bare URLs are left alone; Slack linkifies those itself.
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
      // Slack renders a leading dash literally, so an unordered list arrives looking like prose
      // with hyphens. A bullet is what the writer meant. Numbered lists are left alone: Slack
      // renders "1." correctly, and renumbering is not ours to do.
      .replace(/^([ \t]*)[-*+][ \t]+(?=\S)/gm, "$1• ")
  );
}

/** Convert a model-written markdown message to Slack's mrkdwn. */
export function toMrkdwn(text: string): string {
  if (!text) return text;
  const out = text
    // split() with a capturing group interleaves the delimiters, so odd indices are the protected
    // runs and pass through untouched. Inside each non-protected run, convert tables to code
    // blocks first, then re-protect — the fences they produce must not be re-transformed as prose.
    .split(PROTECTED)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : tablesToCodeBlocks(part)
            .split(PROTECTED)
            .map((p, j) => (j % 2 === 1 ? p : convertSegment(p)))
            .join(""),
    )
    .join("");
  return out.split(BOLD_OPEN).join("*").split(BOLD_CLOSE).join("*");
}
