// Which credential a brain's repository is reached with, and what an agent is told when the
// repository refuses it (Tonoman Cloud docs/definition/objects/brain.md).
import { describe, it, expect } from "vitest";
import { brainCredential, brainFailureText, adoptedSlug, isSetupFault, type LegacySource, type BrainToOpen } from "./credential";
import { makesBrains } from "./credential";

const INITECH_SRC = "11111111-2222-4333-8444-555555555555";
const WIKI_SRC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const INITECH_REPO = "https://github.com/initech-business-sales-springfield/second-brain";
const SOURCES: LegacySource[] = [
  { id: INITECH_SRC, tenant: "initech", repoUrl: INITECH_REPO, branch: "main", secretRef: "secondbrain-initech:GITHUB_TOKEN", guid: "nelly-guid" },
  { id: WIKI_SRC, tenant: "acme", repoUrl: "https://dev.azure.com/acme/team-wiki/_git/team-wiki", branch: "master", subpath: "wiki-main", secretRef: "secondbrain-team-wiki:AZDO_PAT", guid: "sapien-guid" },
];
const ADO = { secret: "brains:AZDO_PAT", org: "acme", project: "brains" };
const adopted = (over: Partial<BrainToOpen> = {}): BrainToOpen => ({ tenant: "initech", repoUrl: INITECH_REPO, kind: "shared", slug: adoptedSlug(INITECH_SRC), branch: "main", ...over });

describe("the credential a brain is reached with", () => {
  it("BRAIN-REACHED-WITH-ITS-OWN-CREDENTIAL a brain adopted from a second-brain source is reached with that source's credential, whichever host it is on", () => {
    // GitHub: before this only a dev.azure.com address was given any credential at all.
    expect(brainCredential(adopted(), SOURCES, ADO)).toEqual({ ref: "secondbrain-initech:GITHUB_TOKEN", guid: "nelly-guid" });
    // An Azure DevOps source uses ITS credential too, not the brains' general one.
    const wiki: BrainToOpen = { tenant: "acme", repoUrl: "https://dev.azure.com/acme/team-wiki/_git/team-wiki", kind: "shared", slug: adoptedSlug(WIKI_SRC), branch: "master", subpath: "wiki-main" };
    expect(brainCredential(wiki, SOURCES, ADO)).toEqual({ ref: "secondbrain-team-wiki:AZDO_PAT", guid: "sapien-guid" });
    // The same repository written another way is still the same repository.
    for (const url of [INITECH_REPO + ".git", INITECH_REPO + "/", INITECH_REPO.replace("github.com", "GitHub.com")]) {
      expect(brainCredential(adopted({ repoUrl: url }), SOURCES, ADO)).toMatchObject({ ref: "secondbrain-initech:GITHUB_TOKEN" });
    }
  });

  it("BRAIN-REACHED-WITH-ITS-OWN-CREDENTIAL being adopted is PROVED, not read off an address: a personal brain pointing at the same repository borrows nothing, and gets no other credential instead", () => {
    for (const notAdopted of [adopted({ kind: "personal", slug: "priya-0123456789ab" }), adopted({ slug: "second-brain-ffffff" }), adopted({ kind: undefined, slug: undefined }), adopted({ subpath: "somewhere/wider" }), adopted({ branch: "other" })]) {
      expect(brainCredential(notAdopted, SOURCES, ADO)).toHaveProperty("fault");
    }
    // Even when the repository sits where the brains' own credential would otherwise apply.
    const adoSources: LegacySource[] = [{ id: WIKI_SRC, tenant: "acme", repoUrl: "https://dev.azure.com/acme/brains/_git/shared", secretRef: "x:Y" }];
    expect(brainCredential({ tenant: "acme", repoUrl: "https://dev.azure.com/acme/brains/_git/shared", kind: "personal", slug: "rod-abc" }, adoSources, ADO)).toHaveProperty("fault");
  });

  it("BRAIN-REACHED-WITH-ITS-OWN-CREDENTIAL by tenant AND repository: another tenant using the same repository never borrows this one's credential", () => {
    expect(brainCredential(adopted({ tenant: "acme" }), SOURCES, ADO)).toHaveProperty("fault");
  });

  it("BRAIN-REACHED-WITH-ITS-OWN-CREDENTIAL a read-only source is never widened into a brain that is written to", () => {
    const ro = SOURCES.map((s) => (s.id === INITECH_SRC ? { ...s, readOnly: true } : s));
    expect(brainCredential(adopted(), ro, ADO)).toHaveProperty("fault");
  });

  it("BRAIN-REACHED-WITH-ITS-OWN-CREDENTIAL two agents carrying the source with DIFFERENT credentials is a set-up fault, not whichever came first; the same credential twice is fine", () => {
    const twice = [...SOURCES, { ...SOURCES[0]!, guid: "other-agent" }];
    expect(brainCredential(adopted(), twice, ADO)).toMatchObject({ ref: "secondbrain-initech:GITHUB_TOKEN" });
    const clash = [...SOURCES, { ...SOURCES[0]!, guid: "other-agent", secretRef: "someone-else:TOKEN" }];
    expect(brainCredential(adopted(), clash, ADO)).toHaveProperty("fault");
    expect(brainCredential(adopted(), clash.slice().reverse(), ADO)).toHaveProperty("fault");
  });

  it("BRAIN-REACHED-WITH-ITS-OWN-CREDENTIAL a brain Tonoman made itself is reached with the brains' own credential - only under the organisation and project Tonoman provisions into, and never as a guess", () => {
    const made: BrainToOpen = { tenant: "initech", repoUrl: "https://dev.azure.com/acme/brains/_git/priya-brain", kind: "personal", slug: "priya-0123" };
    expect(brainCredential(made, SOURCES, ADO)).toEqual({ ref: "brains:AZDO_PAT" });
    expect(brainCredential({ ...made, repoUrl: "https://dev.azure.com/someone-else/brains/_git/x" }, SOURCES, ADO)).toHaveProperty("fault");
    expect(brainCredential({ ...made, repoUrl: "https://dev.azure.com/acme/other-project/_git/x" }, SOURCES, ADO)).toHaveProperty("fault");
    expect(brainCredential(made, SOURCES, { secret: "", org: "acme", project: "brains" })).toHaveProperty("fault");
    expect(brainCredential(made, SOURCES, { secret: "brains:AZDO_PAT" })).toHaveProperty("fault");
    expect(brainCredential({ ...made, repoUrl: "https://gitlab.com/someone/else" }, SOURCES, ADO)).toHaveProperty("fault");
  });
});

describe("what the agent is told when a brain cannot be opened", () => {
  it("BRAIN-REFUSED-IS-NOT-RETRIED a repository that refuses the credential is a set-up fault: the agent is told retrying will not help and an admin must fix it", () => {
    for (const refused of [
      "clone failed: remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/x/y/'",
      "fetch failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "clone failed: remote: Repository not found.\nfatal: repository 'https://github.com/x/y/' not found",
      "this brain has no credential to be reached with: there is no credential for where it lives",
    ]) {
      expect(isSetupFault(refused)).toBe(true);
      const text = brainFailureText(refused);
      expect(text).toMatch(/will not help/i);
      expect(text).toMatch(/admin/i);
      expect(text).not.toMatch(/just now/i);
    }
  });

  it("BRAIN-REFUSED-IS-NOT-RETRIED what may pass is still said to be passing - a network fault is not called a set-up fault", () => {
    for (const passing of ["fetch failed: fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com", "clone failed: error: RPC failed; curl 56 Recv failure: Connection reset by peer", "ETIMEDOUT"]) {
      expect(isSetupFault(passing)).toBe(false);
      expect(brainFailureText(passing)).toMatch(/just now/i);
    }
  });
});

describe("whether this deployment makes brains (BRAIN-MAKING-CAN-BE-OFF)", () => {
  it("BRAIN-MAKING-CAN-BE-OFF with an organisation and project named, brains are made — unless making is switched off", () => {
    const home = { TONOMAN_BRAIN_ADO_ORG: "acme", TONOMAN_BRAIN_ADO_PROJECT: "team-wiki" };
    expect(makesBrains(home)).toBe(true);
    expect(makesBrains({ ...home, TONOMAN_BRAIN_MAKE: "off" })).toBe(false);
    expect(makesBrains({ ...home, TONOMAN_BRAIN_MAKE: " OFF " })).toBe(false);
    expect(makesBrains({ TONOMAN_BRAIN_ADO_ORG: "acme" })).toBe(false); // nowhere to make them
  });

  it("BRAIN-MAKING-CAN-BE-OFF switching making off takes nothing from reaching: an operator's existing repo under the named project still gets the brains' own credential", () => {
    const c = brainCredential({ tenant: "t1", repoUrl: "https://dev.azure.com/acme/team-wiki/_git/finances", kind: "shared", slug: "finances", branch: "main", subpath: null }, [], { secret: "secondbrain-team-wiki:AZDO_PAT", org: "acme", project: "team-wiki" });
    expect(c).toEqual({ ref: "secondbrain-team-wiki:AZDO_PAT" });
  });
});
