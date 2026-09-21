import { describe, expect, it } from "vitest";
import { inputFrom } from "./run";

describe("inputFrom — what the runtime sends is what the Talent gets", () => {
  it("keeps the context: mission, journal, vocab and timezone reach the Talent", () => {
    const context = {
      mission: "Grow Acme",
      journal: { path: "Meeting-Journals", fallback: "unclassified", routes: [{ id: "globex-meetings", when: "Globex" }] },
      vocab: "Tonoman",
      timezone: "America/New_York",
    };
    const input = inputFrom({ item: "rec1", user: "U1", config: { times: "07:00" }, context });
    expect(input).toEqual({ item: "rec1", user: "U1", config: { times: "07:00" }, context });
  });

  it("tolerates an input with no context or config", () => {
    expect(inputFrom({ item: "rec1" })).toEqual({ item: "rec1", config: {}, user: undefined });
  });
});
