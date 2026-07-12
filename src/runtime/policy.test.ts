import { describe, it, expect } from "vitest";
import { authorize, namespaceName, mapCwdToHost, DenyError, type Policy } from "./policy";

// A representative agent policy: one read-write grant whose agent-view path uses
// the Linux sandbox convention, mapped to a Windows host path (the #1 port risk).
const policy: Policy = {
  guid: "7f6a1b6e0c470ac1deadbeef",
  grants: [
    { agentPath: "/root/files/acme", hostPath: "/host/acme" },
    { agentPath: "/root/files/ro", hostPath: "D:/data/ro", readOnly: true },
  ],
};

/** authorize() that returns the joined argv for terse table assertions. */
function ok(argv: string[]): string {
  return authorize(policy, argv).join(" ");
}
/** captures the DenyError reason, or throws if the command was unexpectedly allowed. */
function denyReason(argv: string[]): string {
  try {
    authorize(policy, argv);
  } catch (e) {
    if (e instanceof DenyError) return e.message;
    throw e;
  }
  throw new Error(`expected deny, but allowed: ${argv.join(" ")}`);
}

describe("verb allowlist", () => {
  const allowed = ["run", "build", "compose", "ps", "logs", "exec", "pull", "network", "volume", "version"];
  for (const v of allowed) {
    it(`allows safe verb: ${v}`, () => {
      expect(authorize(policy, [v])).toEqual([v]);
    });
  }

  const denied = ["system", "secret", "login", "machine", "unshare", "rmi-all", "save", "load"];
  for (const v of denied) {
    it(`denies unknown verb: ${v}`, () => {
      expect(denyReason([v])).toContain("not in allowlist");
    });
  }

  it("denies an empty command", () => {
    expect(denyReason([])).toContain("empty command");
  });

  it("honors owner-widened extraVerbs (owner-responsible)", () => {
    const widened: Policy = { ...policy, extraVerbs: ["system"] };
    expect(authorize(widened, ["system", "df"])).toEqual(["system", "df"]);
  });
});

describe("hard-floor denied flags (never allowed, even widened)", () => {
  const widened: Policy = { ...policy, extraVerbs: ["run"] };
  // both bare and =value spellings
  const cases: Array<[string, string[]]> = [
    ["--privileged bare", ["run", "--privileged", "img"]],
    ["--privileged=true", ["run", "--privileged=true", "img"]],
    ["--device bare", ["run", "--device", "/dev/fuse", "img"]],
    ["--device=val", ["run", "--device=/dev/fuse", "img"]],
    ["--cap-add bare", ["run", "--cap-add", "SYS_ADMIN", "img"]],
    ["--cap-add=val", ["run", "--cap-add=SYS_ADMIN", "img"]],
    ["--security-opt bare", ["run", "--security-opt", "label=disable", "img"]],
    ["--security-opt=val", ["run", "--security-opt=label=disable", "img"]],
  ];
  for (const [name, argv] of cases) {
    it(`denies ${name}`, () => {
      expect(denyReason(argv)).toContain("is not permitted");
      // and stays denied even if the owner widened the verb set
      expect(() => authorize(widened, argv)).toThrow(DenyError);
    });
  }
});

describe("namespace flags — deny only isolation-breaking values", () => {
  // space and = spellings, each in deny and allow forms
  it("denies --network host (space)", () => {
    expect(denyReason(["run", "--network", "host", "img"])).toContain("breaks isolation");
  });
  it("denies --network=host (=)", () => {
    expect(denyReason(["run", "--network=host", "img"])).toContain("breaks isolation");
  });
  it("denies --net host (alias)", () => {
    expect(denyReason(["run", "--net", "host", "img"])).toContain("breaks isolation");
  });
  it("denies --pid container:other", () => {
    expect(denyReason(["run", "--pid", "container:other", "img"])).toContain("breaks isolation");
  });
  it("denies --pid=container:other (=)", () => {
    expect(denyReason(["run", "--pid=container:other", "img"])).toContain("breaks isolation");
  });
  it("denies --ipc=host", () => {
    expect(denyReason(["run", "--ipc=host", "img"])).toContain("breaks isolation");
  });
  it("allows a user-defined network (space)", () => {
    expect(ok(["run", "--network", "mynet", "img"])).toBe("run --network mynet img");
  });
  it("allows a user-defined network (=)", () => {
    expect(ok(["run", "--network=mynet", "img"])).toBe("run --network=mynet img");
  });
  it("allows --userns keep-id", () => {
    expect(ok(["run", "--userns", "keep-id", "img"])).toBe("run --userns keep-id img");
  });
});

describe("-v / --volume source rewrite (agent view → host path)", () => {
  // exact-grant-root match, both spellings
  it("rewrites exact grant root (space form, -v dst)", () => {
    expect(ok(["run", "-v", "/root/files/acme:/work", "img"]))
      .toBe("run -v /host/acme:/work img");
  });
  it("rewrites exact grant root (= form)", () => {
    expect(ok(["run", "-v=/root/files/acme:/work", "img"]))
      .toBe("run -v=/host/acme:/work img");
  });
  it("rewrites --volume (space form)", () => {
    expect(ok(["run", "--volume", "/root/files/acme:/work", "img"]))
      .toBe("run --volume /host/acme:/work img");
  });

  // subpath under a grant
  it("rewrites a subpath under the grant", () => {
    expect(ok(["run", "-v", "/root/files/acme/db/init.sql:/init.sql:ro", "img"]))
      .toBe("run -v /host/acme/db/init.sql:/init.sql:ro img");
  });

  // preserves mount options
  it("preserves :ro and :z options", () => {
    expect(ok(["run", "-v", "/root/files/acme:/work:ro,z", "img"]))
      .toBe("run -v /host/acme:/work:ro,z img");
  });

  // backslash normalization on the agent-view source
  it("normalizes backslashes in the agent-view source", () => {
    expect(ok(["run", "-v", "\\root\\files\\acme:/work", "img"]))
      .toBe("run -v /host/acme:/work img");
  });

  // named volume passes through untouched (both forms)
  it("passes a named volume through (space form)", () => {
    expect(ok(["run", "-v", "pgdata:/var/lib/postgresql/data", "img"]))
      .toBe("run -v pgdata:/var/lib/postgresql/data img");
  });
  it("passes a named volume through (= form)", () => {
    expect(ok(["run", "-v=pgdata:/var/lib/postgresql/data", "img"]))
      .toBe("run -v=pgdata:/var/lib/postgresql/data img");
  });

  // ownership: a host path outside every grant is denied
  it("denies a source outside all grants", () => {
    expect(denyReason(["run", "-v", "/etc:/host-etc", "img"])).toContain("outside the agent's grants");
  });
  it("denies a Windows host path that isn't a grant", () => {
    expect(denyReason(["run", "-v", "C:/Windows:/win", "img"])).toContain("outside the agent's grants");
  });
  it("denies the docker socket bind (escape vector outside grants)", () => {
    expect(denyReason(["run", "-v", "/var/run/docker.sock:/var/run/docker.sock", "img"]))
      .toContain("outside the agent's grants");
  });

  // a grant prefix must not match a sibling by string prefix
  it("does not treat /root/files/acme-evil as under /root/files/acme", () => {
    expect(denyReason(["run", "-v", "/root/files/acme-evil:/x", "img"]))
      .toContain("outside the agent's grants");
  });

  it("denies a dangling -v", () => {
    expect(denyReason(["run", "-v"])).toContain("dangling -v");
  });
});

describe("--mount source rewrite", () => {
  it("rewrites source= under a grant (space form)", () => {
    expect(ok(["run", "--mount", "type=bind,source=/root/files/acme,target=/work", "img"]))
      .toBe("run --mount type=bind,source=/host/acme,target=/work img");
  });
  it("rewrites src= alias (= form)", () => {
    expect(ok(["run", "--mount=type=bind,src=/root/files/acme/x,target=/x", "img"]))
      .toBe("run --mount=type=bind,src=/host/acme/x,target=/x img");
  });
  it("passes a named volume mount through", () => {
    expect(ok(["run", "--mount", "type=volume,source=pgdata,target=/data", "img"]))
      .toBe("run --mount type=volume,source=pgdata,target=/data img");
  });
  it("denies a --mount source outside grants", () => {
    expect(denyReason(["run", "--mount", "type=bind,source=/etc,target=/etc", "img"]))
      .toContain("outside the agent's grants");
  });
  it("denies a dangling --mount", () => {
    expect(denyReason(["run", "--mount"])).toContain("dangling --mount");
  });
});

describe("non-mount tokens pass through untouched", () => {
  it("keeps image, ports, env, and command args", () => {
    expect(ok(["run", "-d", "-p", "5432:5432", "-e", "POSTGRES_PASSWORD=x", "postgres:17", "postgres", "-c", "log_statement=all"]))
      .toBe("run -d -p 5432:5432 -e POSTGRES_PASSWORD=x postgres:17 postgres -c log_statement=all");
  });
});

describe("compose path flags (verb-scoped rewrite)", () => {
  it("rewrites an absolute -f compose file under a grant (space form)", () => {
    expect(ok(["compose", "-f", "/root/files/acme/app-stack/compose.yml", "up", "-d"]))
      .toBe("compose -f /host/acme/app-stack/compose.yml up -d");
  });
  it("rewrites --project-directory (= form)", () => {
    expect(ok(["compose", "--project-directory=/root/files/acme/es", "up"]))
      .toBe("compose --project-directory=/host/acme/es up");
  });
  it("rewrites --env-file under a grant", () => {
    expect(ok(["compose", "--env-file", "/root/files/acme/es/.env", "up"]))
      .toBe("compose --env-file /host/acme/es/.env up");
  });
  it("passes a RELATIVE -f through unchanged (cwd resolves it host-side)", () => {
    expect(ok(["compose", "-f", "compose.yml", "up"])).toBe("compose -f compose.yml up");
  });
  it("denies an absolute compose file outside all grants", () => {
    expect(denyReason(["compose", "-f", "/etc/evil/compose.yml", "up"])).toContain("outside the agent's grants");
  });
  it("does NOT treat -f as a path for non-compose verbs (logs -f = follow)", () => {
    expect(ok(["logs", "-f", "mycontainer"])).toBe("logs -f mycontainer");
    expect(ok(["ps", "-f", "status=running"])).toBe("ps -f status=running");
  });
});

describe("mapCwdToHost", () => {
  it("maps a cwd under a grant to its host path", () => {
    expect(mapCwdToHost(policy, "/root/files/acme/app-stack/local-stack"))
      .toBe("/host/acme/app-stack/local-stack");
  });
  it("returns null for a cwd outside every grant", () => {
    expect(mapCwdToHost(policy, "/root")).toBeNull();
  });
});

describe("namespaceName (A11)", () => {
  it("prefixes with the 12-char GUID", () => {
    expect(namespaceName(policy, "pgdata")).toBe("tonoman-7f6a1b6e0c47-pgdata");
  });
  it("is idempotent (does not double-prefix)", () => {
    const once = namespaceName(policy, "net");
    expect(namespaceName(policy, once)).toBe(once);
  });
  it("does not truncate a short GUID", () => {
    expect(namespaceName({ guid: "abc", grants: [] }, "x")).toBe("tonoman-abc-x");
  });
});

describe("`-v` is volume-scoped to run/create/build, not an exec'd command's own flag", () => {
  it("does NOT treat `pg_restore -v <file>` (inside exec) as a volume mount", () => {
    // The live worker fix hit this: `-v` (verbose) + a /tmp path was wrongly read as a
    // bind mount and denied. exec's args belong to the in-container command — pass through.
    expect(ok(["exec", "pg", "pg_restore", "-v", "/tmp/restore.dump"])).toBe(
      "exec pg pg_restore -v /tmp/restore.dump",
    );
  });

  it("still rewrites a real `-v` host mount for run", () => {
    expect(ok(["run", "-v", "/root/files/acme:/work", "img"])).toBe(
      "run -v /host/acme:/work img",
    );
  });

  it("still denies an out-of-grant `-v` host mount for run", () => {
    expect(denyReason(["run", "-v", "/etc:/etc", "img"])).toMatch(/outside the agent's grants/);
  });

  it("does not treat `--volume` as a mount for a non-volume verb", () => {
    expect(ok(["logs", "--volume", "anything", "ctr"])).toBe("logs --volume anything ctr");
  });
});

describe("podman cp — agent-view paths rewritten to host (devcontainerized-broker-cp)", () => {
  it("rewrites an agent-path SOURCE, leaving the container:path dest untouched", () => {
    expect(ok(["cp", "/root/files/acme/db/migration.sql", "pg:/tmp/migration.sql"])).toBe(
      "cp /host/acme/db/migration.sql pg:/tmp/migration.sql",
    );
  });

  it("rewrites an agent-path DEST (container → host copy out)", () => {
    expect(ok(["cp", "pg:/var/log/app.log", "/root/files/acme/logs/app.log"])).toBe(
      "cp pg:/var/log/app.log /host/acme/logs/app.log",
    );
  });

  it("preserves cp flags while rewriting the path", () => {
    expect(ok(["cp", "-a", "/root/files/acme/seed", "pg:/seed"])).toBe(
      "cp -a /host/acme/seed pg:/seed",
    );
  });

  it("denies an absolute host path outside every grant (same floor as -v)", () => {
    expect(denyReason(["cp", "/etc/passwd", "pg:/tmp/x"])).toMatch(/outside the agent's grants/);
  });

  it("leaves a pure container:path ↔ container:path copy untouched", () => {
    expect(ok(["cp", "pg:/a", "app:/b"])).toBe("cp pg:/a app:/b");
  });

  it("only rewrites for the cp verb — a `logs`/`run` positional that looks like a path is left alone", () => {
    // (non-cp verbs never treat a bare absolute positional as a host bind source)
    expect(ok(["logs", "--tail", "5", "mycontainer"])).toBe("logs --tail 5 mycontainer");
  });
});
