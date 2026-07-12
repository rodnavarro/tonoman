import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { teeConsole, gatewayLogPath } from "./logfile";

const origLog = console.log;
afterEach(() => {
  console.log = origLog;
});

// observability — the gateway log persists to a file so turns/errors are inspectable
// (`tonoman logs` / Read), not just on whoever ran `tonoman up`.
describe("teeConsole — persistent gateway log", () => {
  it("gatewayLogPath puts gateway.log under the state root", () => {
    expect(gatewayLogPath("/s/root")).toBe(path.join("/s/root", "gateway.log"));
  });

  it("tees console.log to the file (timestamped) AND still calls through", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tonoman-log-"));
    const file = path.join(dir, "gateway.log");
    let passedThrough = "";
    console.log = (...a: unknown[]) => {
      passedThrough += a.join(" ");
    };
    teeConsole(file);
    console.log("gateway: turn conv=c text=hi");
    await new Promise((r) => setTimeout(r, 50)); // let the stream flush
    const body = await fs.readFile(file, "utf8");
    expect(body).toContain("gateway: turn conv=c text=hi");
    expect(body).toMatch(/^\d{4}-\d\d-\d\dT.*INFO /m); // timestamped + level
    expect(passedThrough).toContain("gateway: turn conv=c text=hi"); // original console still ran
    await fs.rm(dir, { recursive: true, force: true });
  });
});
