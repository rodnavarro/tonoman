// Two clients, because there are two hops.
//
//  CloudApi   → same origin. Who am I, what is my fleet, mint me a gateway token.
//  GatewayApi → the gateway's own origin. Chat and media go here DIRECTLY; they never
//               pass through the cloud (architecture.md §4), which is why a scanned client
//               document does not transit our infrastructure.

export interface FleetAgent {
  id: string;
  name: string;
  role: string | null;
  harness: string;
  status: string;
  /** false => a projection of a self-hosted gateway's roster; not editable from the cloud. */
  managed: boolean;
}

export interface FleetGateway {
  id: string;
  name: string;
  hosting: "cloud" | "self_hosted";
  reachability: "direct" | "dialout";
  endpointUrl: string | null;
  status: string;
  lastSeenAt: string | null;
  agents: FleetAgent[];
}

export class CloudApi {
  constructor(private readonly accessToken: string) {}

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(path, { headers: { authorization: `Bearer ${this.accessToken}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${path}: ${r.status}`);
    return r.json();
  }

  me() {
    return this.get<{ sub: string; email?: string; name?: string; tenantId: string }>("/api/me");
  }

  fleet() {
    return this.get<{ gateways: FleetGateway[] }>("/api/fleet");
  }

  async gatewayToken(gatewayId: string): Promise<{ token: string; expiresIn: number; endpointUrl: string }> {
    const r = await fetch(`/api/gateways/${gatewayId}/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.accessToken}` },
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `token: ${r.status}`);
    return r.json();
  }
}

export interface ChatEvent {
  type: "message" | "update" | "final" | "working" | "settled" | "note";
  id?: string;
  text?: string | null;
  status?: string;
}

export class GatewayApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private url(p: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${p}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  agents() {
    return fetch(this.url("/api/agents"), { headers: this.headers() }).then((r) => r.json());
  }

  /** Uploads one file and returns the path the AGENT will see (the shared mount). */
  async uploadMedia(bytes: Uint8Array | Blob, filename: string): Promise<string> {
    const r = await fetch(this.url("/api/media"), {
      method: "POST",
      headers: this.headers({ "x-filename": filename, "content-type": "application/octet-stream" }),
      body: bytes as BodyInit,
    });
    if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
    return (await r.json()).path as string;
  }

  async send(conversation: string, text: string, mediaPaths: string[] = []): Promise<void> {
    const r = await fetch(this.url(`/api/chat/${encodeURIComponent(conversation)}/messages`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ text, mediaPaths }),
    });
    if (!r.ok) throw new Error(`send failed: ${r.status} ${await r.text()}`);
  }

  /** Opens the SSE stream for a conversation.
   *
   * Uses fetch + ReadableStream rather than EventSource, because EventSource cannot set an
   * Authorization header — the alternative would be putting the token in the query string,
   * where it lands in every proxy access log. */
  async *stream(conversation: string, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const r = await fetch(this.url(`/api/chat/${encodeURIComponent(conversation)}/stream`), {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`stream failed: ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      // SSE frames are separated by a blank line; a frame may span chunk boundaries.
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue; // ": keepalive" comments land here
          try {
            yield JSON.parse(line.slice(5).trim()) as ChatEvent;
          } catch {
            /* ignore a partial/garbled frame rather than killing the stream */
          }
        }
      }
    }
  }
}
