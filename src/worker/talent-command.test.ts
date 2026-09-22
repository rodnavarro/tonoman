// A Talent's program is started as the run's own Linux user, with none of the worker's secrets in its
// environment (TURNUSER-NOTHING-AS-ROOT in Tonoman Cloud's docs/definition/objects/turn-user.md).
import { describe, it, expect } from "vitest";
import { talentCommand } from "./capability-plane";

const worker = { PATH: "/usr/bin", TONOMANCLOUD_API_TOKEN: "sys-secret", SLACK_BOT_TOKEN: "xoxb-secret", TONOMAN_STATE_ROOT: "/root/.tonoman" };

describe("how a Talent's program is started", () => {
  it("TURNUSER-NOTHING-AS-ROOT as the run's user: through the launcher, at home in that user's home, told where to ask the runtime and nothing of the worker's secrets", () => {
    const c = talentCommand({ uid: 20001, home: "/srv/tonoman/homes/20001" }, "node", ["dist/talents/x/index.js"], worker, "http://127.0.0.1:4242", "run-token");
    expect(c.cmd).toBe("setpriv");
    expect(c.args.slice(-2)).toEqual(["node", "dist/talents/x/index.js"]);
    expect(c.env).toMatchObject({ HOME: "/srv/tonoman/homes/20001", TONOMAN_CAPABILITY_URL: "http://127.0.0.1:4242", TONOMAN_CAPABILITY_TOKEN: "run-token" });
    expect(JSON.stringify(c.env)).not.toMatch(/sys-secret|xoxb-secret/);
  });

  it("TURNUSER-NOTHING-AS-ROOT a self-hosted worker, with no user to run as, starts it exactly as before", () => {
    const c = talentCommand(undefined, "tsx", ["src/talents/x/index.ts"], worker, "http://127.0.0.1:4242", "run-token");
    expect(c.cmd).toBe("tsx");
    expect(c.env).toMatchObject({ ...worker, TONOMAN_CAPABILITY_URL: "http://127.0.0.1:4242", TONOMAN_CAPABILITY_TOKEN: "run-token" });
  });
});
