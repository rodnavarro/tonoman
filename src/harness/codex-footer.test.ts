// A Codex turn's footer reads like a Claude turn's (CONVO-FOOTER-BOTH-PROVIDERS): the model calls it
// took and the speaker's own 5h/7d allowance, from the turn's OWN rollout (found by its thread id,
// not by whichever file is newest) — and it runs on the model the turn asked for (INFER-MODEL-IS-DEFAULT).
// The runner is the real one; `codex` is a small fake that writes a rollout the way codex does.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Runner } from "./codex";
import { renderStatus } from "../statusline";
import type { TurnEvent } from "../core/contracts";

let tmp: string;
let home: string;
let fake: string;
const THREAD = "01a0badf-f512-7d63-8f1a-1efdcb9956aa";
const RESET_5H = 1789858066;
const RESET_7D = 1790434933;

const tokenCount = (lastInput: number, used5h: number, used7d: number) =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: lastInput, cached_input_tokens: 0, output_tokens: 50 }, total_token_usage: { input_tokens: 0 } },
      rate_limits: {
        primary: { used_percent: used5h, window_minutes: 300, resets_at: RESET_5H },
        secondary: { used_percent: used7d, window_minutes: 10080, resets_at: RESET_7D },
      },
    },
  });

/** A fake `codex exec --json`: records its argv, writes this thread's rollout, prints the stream. */
function writeFake(calls: number[]): void {
  fake = path.join(tmp, "fake-codex.js");
  writeFileSync(
    fake,
    `const fs=require("fs"),path=require("path");
fs.writeFileSync(${JSON.stringify(path.join(tmp, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
const dir=path.join(process.env.CODEX_HOME,"sessions","2026","09","19"); fs.mkdirSync(dir,{recursive:true});
const lines=${JSON.stringify(calls.map((c, i) => tokenCount(c, 4 + i * 0, 10)))};
fs.writeFileSync(path.join(dir,"rollout-2026-09-19T18-13-54-${THREAD}.jsonl"), lines.join("\\n")+"\\n");
const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");
process.stdin.resume(); process.stdin.on("end",()=>{
  out({type:"thread.started",thread_id:"${THREAD}"});
  out({type:"item.completed",item:{type:"agent_message",text:"Done."}});
  out({type:"turn.completed",usage:{input_tokens:${calls.reduce((a, b) => a + b, 0)},cached_input_tokens:0,output_tokens:${calls.length * 50}}});
});`,
  );
}

async function runTurn(runner: Runner, model?: string): Promise<TurnEvent> {
  let done: TurnEvent | undefined;
  for await (const ev of runner.run({ prompt: "hi", model, configHome: home } as never)) if (ev.kind === "done") done = ev;
  return done!;
}

const newRunner = (model = "sol") => new Runner({ local: true, bin: process.execPath, binArgs: [fake], model, cwd: tmp });

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "codex-footer-"));
  home = path.join(tmp, "home");
  // Another conversation's rollout, NEWER than this turn's: it must not be the one read.
  const other = path.join(home, "sessions", "2026", "09", "20");
  mkdirSync(other, { recursive: true });
  const f = path.join(other, "rollout-2026-09-20T01-00-00-99999999-0000-0000-0000-000000000000.jsonl");
  writeFileSync(f, tokenCount(999_999, 77, 88) + "\n");
  const future = Date.now() / 1000 + 3600;
  utimesSync(f, future, future);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("a Codex turn's footer", () => {
  it("CONVO-FOOTER-BOTH-PROVIDERS a Codex turn counts the model calls it took and reads its own login's 5h and weekly windows", async () => {
    writeFake([16_533, 22_364, 31_111]);
    const done = await runTurn(newRunner());
    const u = done.usage!;
    expect(u.iterationsUsed).toBe(3);
    expect(u.accountWindows).toEqual([
      { key: "5h", usedPct: 4, resetAt: new Date(RESET_5H * 1000).toISOString() },
      { key: "7d", usedPct: 10, resetAt: new Date(RESET_7D * 1000).toISOString() },
    ]);
    // Context is what the LAST call held, not the whole turn's sum.
    expect(u.contextTokens).toBe(31_111);
    const line = renderStatus("small", u, undefined, u.accountWindows!, RESET_5H * 1000 - 3 * 3600_000)!;
    expect(line).toMatch(/^sol · .* tok · ctx 8% · ⟳ 3 · 5h 4% ⏳/);
    expect(line).toMatch(/7d 10%/);
  });

  it("CONVO-FOOTER-BOTH-PROVIDERS a Codex turn that called no tool still took one model call, never ⟳ 0", async () => {
    writeFake([14_300]);
    const done = await runTurn(newRunner());
    expect(done.usage!.iterationsUsed).toBe(1);
  });

  it("INFER-MODEL-IS-DEFAULT a Codex turn runs on the model the turn asks for, not the one the runner was built with", async () => {
    writeFake([14_300]);
    const done = await runTurn(newRunner("sol"), "terra");
    const argv = JSON.parse(readFileSync(path.join(tmp, "argv.json"), "utf8")) as string[];
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.6-terra");
    expect(done.usage!.model).toBe("terra");
  });
});

describe("what a Codex turn leaves in the log", () => {
  it("a Codex turn leaves a result line with its tokens and model calls, as a Claude turn does", async () => {
    writeFake([16_533, 22_364]);
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await runTurn(newRunner());
    } finally {
      console.error = orig;
    }
    expect(lines.some((l) => /^gateway: \[local\] ✓ result \d+tok ⟳2 Done\./.test(l))).toBe(true);
  });
});
