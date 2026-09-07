"""Mirror the worker pod's mounted secrets into a local directory.

The worker resolves `<secret>:<key>` refs by reading `<dir>/<secret>/<key>`. In the pod that tree is
a set of Kubernetes volumes; to run the worker anywhere else it has to be built.

Derived from the DEPLOYMENT's own volumeMounts rather than reconstructed from roster refs. The pod's
mounts are the authoritative list of what it can resolve — a ref-by-ref reconstruction picks up the
Slack tokens and quietly misses the Plaud credential and the second-brain deploy keys, which then
present as "waiting for a login" rather than as a missing mount.

Only paths under /etc/tonoman/secrets/ are mirrored: the claude and state volumes are not secret
trees, and `recap` mounts somewhere else entirely.

Nothing is printed but names and byte counts. Usage:

    python scripts/mirror-secrets.py <namespace> <deployment> <dest-dir>
"""
import base64
import json
import os
import subprocess
import sys


def kubectl(*args: str) -> str:
    return subprocess.run(
        ["kubectl", *args],
        capture_output=True,
        text=True,
        check=True,
        # Explicitly closed: `kubectl` inheriting a loop's stdin is a classic way for one of these
        # to swallow the list it is being driven by.
        stdin=subprocess.DEVNULL,
    ).stdout


def main() -> int:
    ns, deploy, dest = sys.argv[1], sys.argv[2], sys.argv[3]

    spec = json.loads(kubectl("-n", ns, "get", "deploy", deploy, "-o", "json"))["spec"]["template"]["spec"]
    mounts = {m["name"]: m.get("mountPath", "") for m in spec["containers"][0].get("volumeMounts", [])}

    wanted = sorted(
        {
            v["secret"]["secretName"]
            for v in spec.get("volumes", [])
            if "secret" in v and mounts.get(v["name"], "").startswith("/etc/tonoman/secrets/")
        }
    )
    if not wanted:
        print("mirror-secrets: the deployment mounts no secret tree — nothing to do", file=sys.stderr)
        return 1

    total = 0
    for name in wanted:
        try:
            data = json.loads(kubectl("-n", ns, "get", "secret", name, "-o", "json")).get("data", {})
        except subprocess.CalledProcessError as e:
            # Named, and not fatal: one unreadable secret costs one agent, and saying which is the
            # difference between a fixable message and "0 agents".
            print(f"mirror-secrets: could not read {name} — {e.stderr.strip()[:120]}", file=sys.stderr)
            continue
        out = os.path.join(dest, name)
        os.makedirs(out, exist_ok=True)
        for key, b64 in data.items():
            with open(os.path.join(out, key), "wb") as f:
                f.write(base64.b64decode(b64))
            total += 1
        print(f"  {name:22} {len(data)} key(s)")

    print(f"mirror-secrets: {total} file(s) into {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
