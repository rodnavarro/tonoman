import { describe, expect, it } from "vitest";
import { toMrkdwn } from "./mrkdwn";

describe("toMrkdwn — emphasis", () => {
  it("turns markdown bold into Slack bold (the bug on screen)", () => {
    expect(toMrkdwn("**18:25** — a test")).toBe("*18:25* — a test");
    expect(toMrkdwn("__also bold__")).toBe("*also bold*");
  });

  it("does not turn its own bold back into italic on the second pass", () => {
    // The whole reason bold goes via a sentinel: `*x*` looks exactly like markdown italic.
    expect(toMrkdwn("**x**")).toBe("*x*");
    expect(toMrkdwn("**x**")).not.toContain("_");
  });

  it("converts markdown italic to Slack italic", () => {
    expect(toMrkdwn("an *emphatic* word")).toBe("an _emphatic_ word");
  });

  it("leaves a stray asterisk alone", () => {
    expect(toMrkdwn("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(toMrkdwn("see note*")).toBe("see note*");
  });

  it("handles bold inside a numbered list item, which is where it showed up", () => {
    expect(toMrkdwn("1. **18:25** — a test of the agent")).toBe("1. *18:25* — a test of the agent");
  });

  it("keeps bold spanning a line break", () => {
    expect(toMrkdwn("**two\nlines**")).toBe("*two\nlines*");
  });

  it("converts strikethrough", () => {
    expect(toMrkdwn("~~gone~~")).toBe("~gone~");
  });
});

describe("toMrkdwn — structure", () => {
  it("renders a heading as bold, since Slack has no headings", () => {
    expect(toMrkdwn("## Summary")).toBe("*Summary*");
    expect(toMrkdwn("# Title #")).toBe("*Title*");
  });

  it("turns dashes into real bullets", () => {
    expect(toMrkdwn("- one\n- two")).toBe("• one\n• two");
    expect(toMrkdwn("  - nested")).toBe("  • nested");
  });

  it("leaves numbered lists alone — Slack renders those, and renumbering is not ours to do", () => {
    expect(toMrkdwn("1. one\n2. two")).toBe("1. one\n2. two");
  });

  it("converts links to Slack's form", () => {
    expect(toMrkdwn("see [the notes](https://example.com/x)")).toBe("see <https://example.com/x|the notes>");
  });

  it("leaves a bare URL alone — Slack linkifies it itself", () => {
    expect(toMrkdwn("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("toMrkdwn — code is never touched", () => {
  it("leaves a fenced block exactly as written", () => {
    const src = "```\nconst a = b ** 2; // [x](y)\n- not a bullet\n```";
    expect(toMrkdwn(src)).toBe(src);
  });

  it("leaves inline code alone", () => {
    expect(toMrkdwn("run `a ** b` now")).toBe("run `a ** b` now");
  });

  it("still converts prose around a code block", () => {
    expect(toMrkdwn("**before**\n```\nx ** y\n```\n**after**")).toBe("*before*\n```\nx ** y\n```\n*after*");
  });

  it("leaves an existing Slack link alone", () => {
    expect(toMrkdwn("<https://x.com|a_b*c>")).toBe("<https://x.com|a_b*c>");
  });
});

describe("toMrkdwn — total", () => {
  it("passes plain text through untouched", () => {
    expect(toMrkdwn("nothing to do here")).toBe("nothing to do here");
  });

  it("handles empty input", () => {
    expect(toMrkdwn("")).toBe("");
  });

  it("never leaks its sentinels", () => {
    const out = toMrkdwn("**a** ## b\n**c**");
    expect(out).not.toMatch(/[\u0000]/);
  });
});

describe("toMrkdwn — tables", () => {
  it("renders a two-column table as a bold-label list (wraps clean on mobile)", () => {
    const src = "| A | B |\n|---|---|\n| xx | y |";
    expect(toMrkdwn(src)).toBe("*xx:* y");
  });

  it("renders Rod's real recap table as a label list, header dropped, no code block", () => {
    const src = [
      "| Metric | Value |",
      "|---|---|",
      "| Share of driver work spent driving | 65% |",
      "| Fleets running multiple systems | 68% |",
      "| Need system integration support | 65% |",
      "| Need data aggregation and analysis | 45% |",
      "| Need training support | 30% |",
      "| Average minimum experience required | 1.4 years |",
      "| Average actual experience of new hires | 7 years |",
    ].join("\n");
    const out = toMrkdwn(src);
    expect(out).not.toContain("```");
    expect(out).not.toContain("Metric");
    expect(out).toContain("*Share of driver work spent driving:* 65%");
    expect(out).toContain("*Average actual experience of new hires:* 7 years");
    expect(out).toContain("*Average minimum experience required:* 1.4 years");
    const lines = out.split("\n");
    expect(lines.length).toBe(7);
    for (const l of lines) expect(l).toMatch(/^\*[^*]+:\* .+$/);
  });

  it("keeps a three-or-more-column table as an aligned monospace block", () => {
    const out = toMrkdwn("| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |");
    expect(out.startsWith("```\n")).toBe(true);
    expect(out).toContain("A | B | C");
    expect(out).toContain("1 | 2 | 3");
  });

  it("leaves a table written inside a code block byte-identical", () => {
    const src = "```\n| A | B |\n|---|---|\n| x | y |\n```";
    expect(toMrkdwn(src)).toBe(src);
  });

  it("does not mistake a --- horizontal rule for a one-column table", () => {
    expect(toMrkdwn("above\n\n---\n\nbelow")).toBe("above\n\n---\n\nbelow");
  });

  it("handles a borderless two-column table (no outer pipes)", () => {
    expect(toMrkdwn("A | B\n---|---\nx | y")).toBe("*x:* y");
  });

  it("keeps an escaped pipe as literal text inside a cell", () => {
    const bs = String.fromCharCode(92); // one backslash, unambiguous in source
    const out = toMrkdwn("| A | B |\n|---|---|\n| x " + bs + "| y | z |");
    expect(out).toContain("x | y");
  });

  it("still converts emphasis in the prose around a table", () => {
    const out = toMrkdwn("**Numbers:**\n| A | B |\n|---|---|\n| x | y |\nmore **text**.");
    expect(out).toContain("*Numbers:*");
    expect(out).toContain("*text*");
    expect(out).toContain("*x:* y");
  });

  it("strips bold markers inside a cell — the label list would show the asterisks", () => {
    const out = toMrkdwn("| Metric | Value |\n|---|---|\n| **bold label** | x |");
    expect(out).not.toContain("**");
    expect(out).toContain("bold label");
  });
});
