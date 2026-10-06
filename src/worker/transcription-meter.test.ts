// Transcription the platform does is metered (USAGE-TRANSCRIPTION-METERED in Tonoman Cloud): asked
// first, so a refusal is said before the audio is even fetched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio, type TranscriptionMeter } from "./recap";

afterEach(() => vi.unstubAllGlobals());

describe("the transcription meter", () => {
  it("USAGE-TRANSCRIPTION-METERED a refusal stops the transcription before the audio is fetched, with the reason", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const after = vi.fn();
    const meter: TranscriptionMeter = {
      before: async () => {
        throw new Error("not transcribed: transcription is an add-on this organization has not subscribed to");
      },
      after,
    };
    await expect(transcribeAudio("https://audio.example/rec.mp3", "Weekly sync", "rec-1", [], "", undefined, undefined, meter)).rejects.toThrow(/add-on/);
    expect(fetched).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });
});
