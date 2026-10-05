import type { TalentManifest } from './contract';

// Website, as the worker registers it in the Cloud catalogue (website.md in Tonoman Cloud). A Talent
// that works inside the conversation (TALENT-IN-CONVERSATION): while it is on for an agent and the
// site is connected, the turn's `tonoman` has a `site` group. The site keeps its pages as data with a
// draft and a published version; the agent writes drafts, an owner's word publishes
// (D-SITE-CONTENT-IS-DATA). `site` is where visitors find it; `api` is its content API when that is
// not `<site>/api`. The agent's key and the preview secret are the `website` connection.
export const website: TalentManifest = {
  name: 'website',
  version: 1,
  description: "Change the tenant's website from a conversation: pages, their words and their sections, saved as drafts with a preview link, published on an owner's word.",
  requires: [{ kind: 'website' }],
  configSchema: [
    { key: 'site', type: 'text', label: "The site's address (https://…)", required: true },
    { key: 'api', type: 'text', label: 'Its content API, when it is not <site>/api' },
  ],
};
