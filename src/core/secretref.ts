// Which SCHEME a credential ref names.
//
// Two of them, one character apart in appearance and a world apart in effect:
//
//   `<secret>:<key>`   a MOUNTED Kubernetes secret — the original contract.
//   `registry:<ref>`   a row in the registry's `secret` table, fetched over the system-token API and
//                      decrypted on the far side, so nothing here ever holds the key.
//
// The second exists because a path is a property of the POD, and one pod serves every tenant it has
// agents for. A Slack bot token pasted into the Hub can never become a file on that pod without a
// redeploy and a secret in a cluster manifest — which is the whole thing self-service was for.
//
// THE PREFIX IS CHECKED FIRST, and that is the point of this module existing at all:
// `registry:slack.bot-token` satisfies the mounted-secret grammar perfectly well, so read the old
// way it looks for a file at `<secrets-dir>/registry/slack.bot-token`, does not find one, and
// returns "" — an agent reported as having no bot token while its token sits encrypted in the
// registry, with no error anywhere to say so.
//
// It lives in core/ because BOTH halves resolve refs and neither should import the other: the
// worker resolves a Talent's provider keys and a second brain's push token, and the control plane
// resolves each agent's Slack tokens while building the roster. One rule, read the same way twice.

/** PURE: which scheme a credential ref names, and what is left after it. */
export function parseRef(ref: string | null | undefined): { kind: "registry" | "mount"; ref: string } | undefined {
  const t = (ref ?? "").trim();
  if (!t) return undefined;
  // No character class on the registry side, on purpose: the API owns that namespace, and the value
  // is URL-encoded into a request path rather than joined onto a filesystem one. The whole rest of
  // the string is the ref name — a name with its own colon belongs entirely to the registry, and
  // splitting again here would hand the API half of one.
  if (t.startsWith("registry:")) {
    const name = t.slice("registry:".length);
    return name ? { kind: "registry", ref: name } : undefined;
  }
  return { kind: "mount", ref: t };
}

/** PURE: split a mounted ref into its `<secret>` and `<key>`, or undefined when it is not one.
 *
 *  A ref comes from a database edited through a web form, so anything that could climb out of the
 *  mount is refused rather than read — this is the check, and it is here so both resolvers get it. */
export function parseMountRef(ref: string): { secret: string; key: string } | undefined {
  const i = ref.indexOf(":");
  if (i < 0) return undefined;
  const secret = ref.slice(0, i);
  const key = ref.slice(i + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(secret) || !/^[A-Za-z0-9._-]+$/.test(key)) return undefined;
  return { secret, key };
}

/** The API path one agent's registry secret is read from. Built here so the two resolvers cannot
 *  drift into asking two different routes for the same thing. */
export function registrySecretPath(guid: string, ref: string): string {
  return `/v1/system/agents/${guid}/secrets/${encodeURIComponent(ref)}`;
}
