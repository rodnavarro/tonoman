import type { TalentManifest } from '../../../talent-sdk';

// The LOREALISTAR drop watcher: each person connects their own login (`!connect lorealistar`), the
// runtime looks every few minutes, and each new drop becomes one run of this Talent — a page in the
// person's brain, and the site's own figures said to them at once.
export const manifest: TalentManifest = {
  name: 'drop-watch',
  version: 1,
  description: 'Watch LOREALISTAR for new drops, for each person who connects their own login, and tell them the moment one appears.',
  requires: [{ kind: 'lorealistar' }],
  capabilities: ['lorealistar', 'page'],
  configSchema: [
    { key: 'output_channel', type: 'channel', label: 'Where new drops are announced' },
    { key: 'every_minutes', type: 'text', label: 'How often to look, in minutes (5 unless said)' },
    { key: 'brain', type: 'brain', label: 'Where each drop gets its page (the person’s own brain unless said)' },
  ],
};
