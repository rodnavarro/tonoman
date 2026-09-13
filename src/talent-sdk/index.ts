// The Talent SDK's public surface. A Talent imports from here and nowhere in the runtime.
//
// `runCli` (the bootstrap that reads env + stdin, builds the context, and writes the outcome) lands
// in the next increment alongside the capability plane it talks to; the types are the stable
// contract both the plane and the CLI target.
export type {
  TalentManifest,
  CredentialRequirement,
  CapabilityName,
  ConfigField,
  ConfigFieldType,
  TalentInput,
  TalentOutcome,
  TalentContext,
  TalentRun,
  TranscribeCapability,
  InferCapability,
  PublishCapability,
} from './types';
