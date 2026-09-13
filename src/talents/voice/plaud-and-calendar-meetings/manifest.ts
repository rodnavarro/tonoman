import type { TalentManifest } from '../../../talent-sdk';

// The Plaud Talent — the built-in REFERENCE Talent, and the first program on the framework.
//
// It lives in its own folder and will be a self-contained CLI: its `run` (next increment) is the
// proven voice pipeline — transcribe → classify against the tenant mission → recap → file in the
// second brain → report — ported from the worker and rewritten to call the capability plane instead
// of importing worker internals.
//
// Note the split the CLI model makes clean, versus the 3a manifest:
//   - `requires` now lists only RAW credentials the Talent holds and uses directly — Plaud, and a
//     calendar (optional). Transcription is NOT here: it is a mediated capability, so WHICH engine
//     transcribes (groq / Cloud-hosted local-gpu) stays the runtime's provider chain.
//   - `capabilities` lists what the Talent calls through the plane: transcribe, infer, publish.
//
// The folder is named for what it does; the manifest `name` is the canonical id the `talent` row,
// the roster and `talent_run` key on, and it stays `meeting-recap` (renaming the id is a migration,
// a separate decision). Changing `requires`/`capabilities`/`configSchema` is a code change = a new
// `version`, reported to the Cloud catalogue by worker-boot registration.
export const manifest: TalentManifest = {
  name: 'meeting-recap',
  version: 2,
  description:
    'Transcribe a recording, summarise it against the tenant mission, file it in the second brain and report it.',
  requires: [{ kind: 'plaud' }, { kind: 'calendar', optional: true }],
  capabilities: ['transcribe', 'infer', 'publish'],
  configSchema: [
    { key: 'output_channel', type: 'channel', label: 'Where recaps are announced' },
    // Reply-in-thread mode; the channel decision and the watching are the worker's (the runtime owns
    // the connector), so this field is a runtime hint, not something the CLI acts on. Kept in step
    // with the worker manifest — the registered one — so the two never disagree on the schema.
    { key: 'reply_in_thread', type: 'toggle', label: 'Answer questions in-thread in the output channel' },
  ],
};
