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
  // 3: the calendar requirement changed strength (optional → required-with-fallback). The manifest
  // is DATA the Cloud catalogue stores, so a change to it is a new version by the same rule a
  // config-schema change is — the registry should never hold v2's requirements under v2's number.
  version: 3,
  description:
    'Transcribe a recording, summarise it against the tenant mission, file it in the second brain and say so.',
  requires: [
    { kind: 'plaud' },
    { kind: 'transcription' },
    // REQUIRED, and it degrades. A recap without a calendar cannot say which meeting a recording
    // was, which is half of what makes it findable later — so the Hub should ask for one and a
    // person should know what they are missing. But a tenant that has not connected a calendar
    // still needs their meetings filed, so the run goes ahead and says so. Marked `optional` before
    // this, it was invisible: nothing asked, nothing mentioned it, and the degraded recap looked
    // exactly like the good one.
    {
      kind: 'calendar',
      providers: ['ics', 'google'],
      fallback: 'Meetings are filed without calendar matching until a calendar is connected.',
    },
  ],
  configSchema: [
    { key: 'output_channel', type: 'channel', label: 'Where recaps are announced' },
    // When on, the agent answers plain messages in the output channel as thread replies — no
    // @mention needed — so a recap and the questions it prompts stay in one place. Off by default;
    // reading it needs the app's `channels:history` scope + a `message.channels` subscription, so
    // turning it on is gated on a Slack reinstall.
    { key: 'reply_in_thread', type: 'toggle', label: 'Answer questions in-thread in the output channel' },
  ],
  schedule: { kind: 'interval', summary: 'Checks for new recordings every couple of minutes' },
};
