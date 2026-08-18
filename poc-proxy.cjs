// LAN forward for the POC — the SAME mechanism tonoman's `expose` uses: a Node
// userland TCP proxy (dist/runtime/proxy.tcpProxy) binding the LAN IP -> 127.0.0.1.
// No netsh, no admin. Windows Firewall may still block CROSS-DEVICE inbound on a
// Public network (that part needs a one-time firewall allow); same-machine works now.
const { tcpProxy } = require("./dist/runtime/proxy.js");

const BIND = process.argv[2] || "192.168.4.23";
const PORT = Number(process.argv[3] || 7681);

tcpProxy(BIND, PORT, "127.0.0.1", PORT)
  .then(() => console.log(`poc-proxy: ${BIND}:${PORT} -> 127.0.0.1:${PORT} (tonoman tcpProxy)`))
  .catch((e) => {
    console.error(`poc-proxy: could not bind ${BIND}:${PORT} — ${e.message}`);
    process.exit(1);
  });
// keep the process alive
setInterval(() => {}, 1 << 30);
