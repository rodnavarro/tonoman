import type { TalentManifest } from './contract';
import { meetingRecap } from './meeting-recap';

// The built-in Talent registry — the manifests this worker ships with. Pluggable by design: this is
// the "built-in" source; Cloud-install and marketplace are future sources that would add entries the
// same shape. Registration reads this list and reports it to the Cloud `talent` registry.
//
// The run IMPLEMENTATION for a built-in Talent is a worker workflow (the Plaud Talent's is the voice
// pipeline via runTalentWorkflow). A generic name@version→run dispatch is unnecessary while there is
// one Talent; it becomes a map the day a second built-in Talent needs its own workflow.
export const BUILTIN_TALENTS: readonly TalentManifest[] = [meetingRecap];

export function getTalent(name: string, version?: number): TalentManifest | undefined {
  return BUILTIN_TALENTS.find((t) => t.name === name && (version === undefined || t.version === version));
}
