import type { SkillManifest } from './contract';
import { RUNTIME_REPO } from './contract';

// Receipts, as the worker registers it in the Cloud catalogue (receipt.md in Tonoman Cloud). A Skill
// that works inside the conversation (SKILL-IN-CONVERSATION): while it is on for an agent, the turn's
// `tonoman` has a `receipts` group and a short note on filing, and each filing is a run. It files into
// the brain chosen in its settings (SKILL-BRAIN-SETTING); `entities` are the tenant's legal entities,
// one of which every receipt must name (RECEIPT-ENTITY-ALWAYS).
export const receipts: SkillManifest = {
  name: 'receipts',
  source: { repo: RUNTIME_REPO, path: 'src/worker/skills/receipts.ts' },
  version: 1,
  description: 'File receipts, invoices and statements people send, with their row in the ledger, as the finances repo expects.',
  requires: [],
  configSchema: [
    { key: 'brain', type: 'brain', label: 'Brain it files into', required: true },
    { key: 'entities', type: 'text', label: 'Legal entities, comma-separated (every receipt names one)' },
  ],
};
