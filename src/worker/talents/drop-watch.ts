import type { TalentManifest } from './contract';

// The LOREALISTAR drop watcher, as the worker registers it in the Cloud catalogue. Kept in step with
// the Talent's own manifest (src/talents/lorealistar/drop-watch/manifest.ts).
export const dropWatch: TalentManifest = {
  name: 'drop-watch',
  version: 1,
  description: 'Watch LOREALISTAR for new drops, for each person who connects their own login, and tell them the moment one appears.',
  requires: [{ kind: 'lorealistar' }],
  configSchema: [
    // DROPS-IN-A-CHANNEL: chosen like a recap's. A grant that names none tells each person privately.
    { key: 'output_channel', type: 'channel', label: 'Where new drops are announced' },
    { key: 'every_minutes', type: 'text', label: 'How often to look, in minutes (5 unless said)' },
    { key: 'brain', type: 'brain', label: 'Where each drop gets its page (the person’s own brain unless said)' },
  ],
  schedule: { kind: 'interval', summary: 'Looks every few minutes for each person who has connected' },
};

/** How often it looks when the grant does not say, and the bounds a setting is held to: never so
 *  often that it hammers the site (DROPS-GENTLE), never so rarely that a drop is gone before it looks. */
/** The channel a grant names for new drops (DROPS-IN-A-CHANNEL), or none: a grant made before the
 *  setting existed names none, and its people go on being told privately. */
export function dropChannel(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export const DEFAULT_DROP_MINUTES = 5;
export function dropEveryMinutes(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_DROP_MINUTES;
  return Math.min(60, Math.max(2, Math.round(n)));
}
