// A turn's environment: `tonoman` first on the PATH, and this turn's token only (cli.md in Tonoman
// Cloud). Titles start with the rule they prove.
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { withCli } from "./turnenv";

describe("the turn's tonoman", () => {
  it("CLI-ACTS-AS-SPEAKER the turn's environment finds tonoman first and carries this turn's token, and only this turn's", () => {
    const env = withCli({ PATH: ["/usr/bin", "/bin"].join(path.delimiter), TONOMAN_BRAIN_TOKEN: "someone-else" }, { binDir: "/srv/tonoman/bin", env: { TONOMAN_BRAIN_URL: "http://127.0.0.1:9", TONOMAN_BRAIN_TOKEN: "mine" } });
    expect(env.PATH!.split(path.delimiter)[0]).toBe("/srv/tonoman/bin");
    expect(env.TONOMAN_BRAIN_TOKEN).toBe("mine");
  });
});
