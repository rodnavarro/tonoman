// The Talent framework — Tonoman OSS's runtime contract for a Talent.
//
// A Talent is the single versioned unit an agent runs. It is CODE behind a MANIFEST, not interpreted
// steps: the step interpreter this replaced (skill.ts / runSkillWorkflow / runStep) is deleted. The
// manifest is DATA — what the Talent needs and what it can be configured with — declared in code and
// reported to the Cloud `talent` registry so a tenant can install it. The implementation is a
// workflow the worker runs (for the built-in Plaud Talent, the proven voice pipeline).
//
// "Where a Talent comes from" is a pluggable SOURCE, not a fixed place: built-in (this tree) today,
// a Cloud install and a marketplace later. This contract is the shape every source produces.

/** One credential the Talent needs. `optional` distinguishes "cannot run without it" (Plaud) from
 *  "works, just does less" (a calendar — no calendar means an empty candidate list, not a failure).
 *  `transcription` is met by construction: there is always a platform/tenant provider chain, so it
 *  is a capability the runtime supplies below the Talent, not a per-user account to connect. */
export interface CredentialRequirement {
  kind: string;
  optional?: boolean;
}

export type ConfigFieldType = 'channel' | 'channel_list' | 'text' | 'toggle';

/** One typed field an agent fills when the Talent is installed. The Hub renders a form from these
 *  (a later wave); the worker reads the saved values. Adding a field is a code change = a new
 *  version, which is the whole point of the manifest being declared in code. */
export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  label?: string;
  required?: boolean;
}

/** A Talent's manifest: its identity and its declared, deterministic requirements + config. This is
 *  what registration upserts into the Cloud `talent` registry (git = source of truth). */
export interface TalentManifest {
  name: string;
  version: number;
  description?: string;
  requires: CredentialRequirement[];
  configSchema: ConfigField[];
}
