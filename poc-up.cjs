// POC dev container (path B): create a plain podman container whose bind mounts are
// rendered by tonoman's OWN mount code (dist/mounts.podmanVolumeArgs) — so the folder
// grants come from a tonoman AgentConfig, not a hardcoded -v list. Publishes 7681 for ttyd.
const { execFileSync } = require("node:child_process");
const { podmanVolumeArgs } = require("./dist/mounts.js");

// A tonoman AgentConfig fragment — the very thing tonoman's config supports. Add/adjust
// mounts here and re-run to re-grant folders. host uses forward slashes (podman-machine
// translates C:/ -> /mnt/c automatically).
const agent = {
  name: "poc",
  mounts: [
    { name: "p", host: "C:/Users/rnavarro/P" }, // dev workspace (rw) -> /root/files/p
  ],
};

const vols = podmanVolumeArgs(agent);
const args = [
  "run", "-d", "--name", "poc",
  ...vols,
  "-p", "0.0.0.0:7681:7681",
  "localhost/tonoman/claudecode:latest",
  "sleep", "infinity",
];

console.log("podman", args.join(" "));
const out = execFileSync("podman.exe", args, { encoding: "utf8" });
console.log("container id:", out.trim());
