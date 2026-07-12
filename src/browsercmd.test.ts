import { describe, it, expect } from "vitest";
import { browserContainer, browserProfileVolume, browserRunArgs, parseBrowserPurge, CHROME_IMAGE } from "./browsercmd";

// browser-sidecar — the per-agent sidecar's name/volume/run-args are derived purely from the
// agent, so the provisioning contract is testable without podman (A14).
describe("browser sidecar provisioning (browser-sidecar)", () => {
  it("names the sidecar off the agent's container (env suffix rides along)", () => {
    expect(browserContainer("reacher")).toBe("reacher-chrome");
    expect(browserContainer("reacher-dev")).toBe("reacher-dev-chrome"); // cli-env suffix preserved
  });

  it("keys the persistent profile volume by the stable GUID (survives rename)", () => {
    expect(browserProfileVolume("90aded024b380afc")).toBe("tonoman-chrome-90aded024b380afc");
  });

  it("browserRunArgs publishes CDP+noVNC to host loopback, mounts the profile, labels ownership", () => {
    const args = browserRunArgs({
      container: "reacher-chrome",
      guid: "g1",
      profileVolume: "tonoman-chrome-g1",
      novncPassword: "deadbeef",
    });
    // leading run -d --name
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--name", "reacher-chrome"]);
    // ownership label (A11)
    expect(args).toContain("tonoman.agent=g1");
    // CDP + noVNC auto-allocated on a host port (all-interfaces so siblings reach it via
    // host.containers.internal; WSL2-podman still surfaces only on Windows loopback)
    expect(args).toContain("0.0.0.0::9222");
    expect(args).toContain("0.0.0.0::6080");
    // persistent profile volume at Chrome's user-data-dir
    expect(args).toContain("tonoman-chrome-g1:/home/chrome/.chrome:rw");
    // noVNC viewer password passed in (so `open browser` can surface it)
    expect(args).toContain("TONOMAN_CHROME_NOVNC_PASSWORD=deadbeef");
    // the tonoman/chrome image is last, NOT the agent's harness image
    expect(args[args.length - 1]).toBe(CHROME_IMAGE);
  });

  it("honors an explicit image override", () => {
    const args = browserRunArgs({ container: "c", guid: "g", profileVolume: "v", novncPassword: "p", image: "localhost/x:dev" });
    expect(args[args.length - 1]).toBe("localhost/x:dev");
  });

  it("parseBrowserPurge detects --purge", () => {
    expect(parseBrowserPurge(["-a", "reacher"])).toBe(false);
    expect(parseBrowserPurge(["-a", "reacher", "--purge"])).toBe(true);
  });
});
