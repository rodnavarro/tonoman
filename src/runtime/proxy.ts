// In-process TCP reverse-proxy — the host side of `tonoman expose` (devcontainerized-
// expose-url). The gateway (running as the user, NO admin) binds a host network
// interface and pipes each connection to the service's loopback-published port. This is
// how an off-host device (the operator's phone on WiFi) reaches a service that podman
// published only on host-loopback (the podman-in-WSL2 case), and it is the same
// mechanism as the "single authenticated Tonoman ingress" endgame.
//
// Why a specific bind host (not 0.0.0.0): the service is already bound on
// 127.0.0.1:<port>, so listening on 0.0.0.0:<port> would collide. Binding the LAN
// interface (e.g. 192.168.4.80:<port>) and forwarding to 127.0.0.1:<port> avoids the
// conflict and needs no admin / no global network change.

import * as net from "node:net";

export interface ProxyHandle {
  /** the actually-bound port (resolves an ephemeral 0 request). */
  port: number;
  /** stop accepting + drop live connections. */
  close: () => Promise<void>;
}

/** Starts a TCP proxy: accept on listenHost:listenPort, pipe each connection to
 * targetHost:targetPort. Rejects if the listen bind fails (e.g. address in use / not
 * available) so the caller can report an honest error instead of false success. */
export function tcpProxy(listenHost: string, listenPort: number, targetHost: string, targetPort: number): Promise<ProxyHandle> {
  return new Promise((resolve, reject) => {
    const live = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      live.add(sock);
      const up = net.connect(targetPort, targetHost);
      live.add(up);
      const kill = (): void => {
        sock.destroy();
        up.destroy();
        live.delete(sock);
        live.delete(up);
      };
      sock.on("error", kill);
      up.on("error", kill);
      sock.on("close", kill);
      up.on("close", kill);
      sock.pipe(up);
      up.pipe(sock);
    });
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.removeListener("error", reject);
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            for (const s of live) s.destroy();
            live.clear();
            server.close(() => res());
          }),
      });
    });
  });
}
