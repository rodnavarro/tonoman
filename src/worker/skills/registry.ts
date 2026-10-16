import type { SkillManifest } from './contract';
import { agendaBrief } from './agenda-brief';
import { dropWatch } from './drop-watch';
import { meetingRecap } from './meeting-recap';
import { receipts } from './receipts';

// The built-in Skill registry — the manifests this worker ships with. Pluggable by design: this is
// the "built-in" source; Cloud-install and marketplace are future sources that would add entries the
// same shape. Registration reads this list and reports it to the Cloud `skill` registry.
//
// The run IMPLEMENTATION for a built-in Skill is a worker workflow (the Plaud Skill's is the voice
// pipeline via runSkillWorkflow). A generic name@version→run dispatch is unnecessary while there is
// one Skill; it becomes a map the day a second built-in Skill needs its own workflow.
export const BUILTIN_SKILLS: readonly SkillManifest[] = [meetingRecap, agendaBrief, receipts, dropWatch];

export function getSkill(name: string, version?: number): SkillManifest | undefined {
  return BUILTIN_SKILLS.find((t) => t.name === name && (version === undefined || t.version === version));
}
