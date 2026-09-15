import type { TalentManifest } from './contract';

// The Plaud Talent — the built-in REFERENCE Talent, and the first program on the framework.
//
// Its run is the proven voice pipeline (`processRecording`): transcribe → classify against the
// tenant mission → recap → file in the second brain → announce. It is provider-agnostic: it declares
// `transcription`, and WHICH engine transcribes (groq, or Cloud-hosted local-gpu) is the tenant's
// provider chain, resolved below the Talent. That is why this can live in OSS while the GPU capacity
// stays a Cloud-billed service at the provider layer.
//
// `requires` mirrors what the pipeline actually needs; `configSchema` is the output channel the Hub
// will let an agent set. Changing either is a code change and a new `version`.
export const meetingRecap: TalentManifest = {
  name: 'meeting-recap',
  version: 2,
  description:
    'Transcribe a recording, summarise it against the tenant mission, file it in the second brain and say so.',
  requires: [{ kind: 'plaud' }, { kind: 'transcription' }, { kind: 'calendar', optional: true }],
  configSchema: [
    { key: 'output_channel', type: 'channel', label: 'Where recaps are announced' },
    // When on, the agent answers plain messages in the output channel as thread replies — no
    // @mention needed — so a recap and the questions it prompts stay in one place. Off by default;
    // reading it needs the app's `channels:history` scope + a `message.channels` subscription, so
    // turning it on is gated on a Slack reinstall.
    { key: 'reply_in_thread', type: 'toggle', label: 'Answer questions in-thread in the output channel' },
  ],
};
