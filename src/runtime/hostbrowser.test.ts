import { describe, it, expect } from "vitest";
import { chromeLaunchArgs, hostBrowserCandidates } from "./hostbrowser";

// browser-host-chrome — the broker launches a real host Chrome with CDP; the launch flags +
// executable discovery are pure, so they're unit-tested without spawning Chrome (A14).
describe("host browser launch (browser-host-chrome)", () => {
  it("chromeLaunchArgs enables remote CDP, binds wide, allows remote origins, uses a dedicated profile", () => {
    const args = chromeLaunchArgs({ port: 9333, profileDir: "C:/state/host-chrome-profile" });
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--remote-debugging-address=0.0.0.0"); // reachable from the agent container by IP
    expect(args).toContain("--remote-allow-origins=*"); // modern Chrome blocks remote CDP WS otherwise
    expect(args).toContain("--user-data-dir=C:/state/host-chrome-profile"); // dedicated, persistent (logins survive)
    expect(args[args.length - 1]).toBe("about:blank"); // default start page
  });

  it("honors a custom address + start url", () => {
    const args = chromeLaunchArgs({ port: 1, profileDir: "p", address: "172.19.128.1", startUrl: "https://x" });
    expect(args).toContain("--remote-debugging-address=172.19.128.1");
    expect(args[args.length - 1]).toBe("https://x");
  });

  it("discovers Chrome then Edge from Program Files", () => {
    const norm = (p: string): string => p.replace(/\\/g, "/"); // separator-agnostic (Windows path.join → \)
    const c = hostBrowserCandidates({ ProgramFiles: "C:/PF", "ProgramFiles(x86)": "C:/PF86", LOCALAPPDATA: "C:/LA" } as NodeJS.ProcessEnv).map(norm);
    expect(c[0]).toContain("Google/Chrome/Application/chrome.exe");
    expect(c.some((p) => p.includes("Microsoft/Edge/Application/msedge.exe"))).toBe(true);
  });
});
