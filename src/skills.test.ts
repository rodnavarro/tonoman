import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assembleSkills, parseAssignments } from "./skills";

async function mkskill(root: string, name: string, withScript?: string): Promise<void> {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, name, "SKILL.md"), `# ${name}`);
  if (withScript) {
    await fs.mkdir(path.join(root, name, "scripts"), { recursive: true });
    await fs.writeFile(path.join(root, name, "scripts", withScript), "#!/usr/bin/env node\n");
  }
}

describe("assembleSkills (learn-durable read-side)", () => {
  it("merges platform + registry skills into the target and exposes scripts on PATH", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "tnskills-"));
    const platform = path.join(base, "platform");
    const registry = path.join(base, "registry");
    const target = path.join(base, "skills");
    const bin = path.join(base, "bin");
    await mkskill(platform, "tonoman-self");
    await mkskill(registry, "finance-intake", "finance.mjs");
    await mkskill(registry, "wiki-curate", "wiki.mjs");

    const r = await assembleSkills({ target, platformDir: platform, registryDir: registry, binDir: bin });
    expect(r.skills.sort()).toEqual(["finance-intake", "tonoman-self", "wiki-curate"]);
    // the harness sees all three, and each resolves to its real SKILL.md (symlink)
    expect(await fs.readFile(path.join(target, "tonoman-self", "SKILL.md"), "utf8")).toBe("# tonoman-self");
    expect(await fs.readFile(path.join(target, "finance-intake", "SKILL.md"), "utf8")).toBe("# finance-intake");
    // scripts are on PATH, named without extension (kubectl-style `finance`)
    expect(r.scripts.sort()).toEqual(["finance.mjs", "wiki.mjs"]);
    expect(await fs.stat(path.join(bin, "finance"))).toBeTruthy();
    await fs.rm(base, { recursive: true, force: true });
  });

  it("honors an assignment filter (only assigned registry skills load); platform always loads", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "tnskills-"));
    const platform = path.join(base, "platform");
    const registry = path.join(base, "registry");
    const target = path.join(base, "skills");
    await mkskill(platform, "tonoman-self");
    await mkskill(registry, "finance-intake");
    await mkskill(registry, "some-other-agents-skill");

    const r = await assembleSkills({ target, platformDir: platform, registryDir: registry, assigned: ["finance-intake"] });
    expect(r.skills.sort()).toEqual(["finance-intake", "tonoman-self"]); // not the unassigned one
    await fs.rm(base, { recursive: true, force: true });
  });

  it("is idempotent and prunes a removed skill on re-assembly", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "tnskills-"));
    const registry = path.join(base, "registry");
    const target = path.join(base, "skills");
    await mkskill(registry, "a");
    await mkskill(registry, "b");
    await assembleSkills({ target, registryDir: registry });
    expect((await fs.readdir(target)).sort()).toEqual(["a", "b"]);
    // b is unassigned on the next run → its symlink is pruned
    const r = await assembleSkills({ target, registryDir: registry, assigned: ["a"] });
    expect(r.skills).toEqual(["a"]);
    expect(await fs.readdir(target)).toEqual(["a"]);
    await fs.rm(base, { recursive: true, force: true });
  });
});

describe("assembleSkills — shared lib CLIs on PATH", () => {
  it("exposes a lib/<tool> by its package.json bin (kubectl-style, callable by name)", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "tnlib-"));
    const registry = path.join(base, "registry");
    const target = path.join(base, "skills");
    const bin = path.join(base, "bin");
    // lib/rn with a package.json bin → `rn`
    await fs.mkdir(path.join(registry, "lib", "rn"), { recursive: true });
    await fs.writeFile(path.join(registry, "lib", "rn", "cli.js"), "#!/usr/bin/env node\n");
    await fs.writeFile(path.join(registry, "lib", "rn", "package.json"), JSON.stringify({ type: "module", bin: { rn: "cli.js" } }));
    await mkskill(path.join(registry, "skills"), "finance-intake");

    const r = await assembleSkills({ target, registryDir: path.join(registry, "skills"), libDir: path.join(registry, "lib"), binDir: bin });
    expect(r.scripts).toContain("rn"); // `rn` is on PATH
    expect(await fs.readFile(path.join(bin, "rn"), "utf8")).toContain("#!/usr/bin/env node");
    await fs.rm(base, { recursive: true, force: true });
  });
});

describe("parseAssignments", () => {
  const yaml = `# comment
assignments:
  sapien:
    - finance-intake
    - wiki-curate
  cody:
    - devcontainer-fix
`;
  it("returns an agent's assigned skills", () => {
    expect(parseAssignments(yaml, "sapien")).toEqual(["finance-intake", "wiki-curate"]);
    expect(parseAssignments(yaml, "cody")).toEqual(["devcontainer-fix"]);
  });
  it("returns undefined for an agent not listed (→ caller loads all)", () => {
    expect(parseAssignments(yaml, "cardy")).toBeUndefined();
  });
});
