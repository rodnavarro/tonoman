// Shapes taken from the live API, not from reading a client and guessing.
//
// The guesses were wrong in three places, and each would have failed quietly rather than loudly:
// the list envelope is `data` (not `items`), `start_at` is an ISO string (not epoch milliseconds),
// and `duration` is already milliseconds. A recording parsed with any of those wrong still
// produces a Recording object — with the wrong date, which is exactly the kind of bug that reaches
// a customer's second brain before anyone notices.

import { describe, expect, it } from "vitest";
import { toMs, toRecording, stampFor } from "./plaudapi";

/** Copied verbatim from a real response. */
const REAL = {
  id: "3e531b8928ce0502927ac3b902c29c00",
  name: "2026-09-06 23:10:46",
  created_at: "2026-09-07T03:11:13",
  serial_number: "1788750646379",
  start_at: "2026-09-07T03:10:46.379000",
  duration: 31000,
};

describe("toMs — the field that was wrong", () => {
  it("reads an ISO string with no zone as UTC, which is what Plaud means", () => {
    // JavaScript reads a zoneless ISO string as LOCAL time. Left alone, the same recording lands
    // on a different day depending on where the pod runs.
    expect(toMs("2026-09-07T03:10:46.379000")).toBe(Date.parse("2026-09-07T03:10:46.379Z"));
  });

  it("leaves an explicit zone alone", () => {
    expect(toMs("2026-09-07T03:10:46Z")).toBe(Date.parse("2026-09-07T03:10:46Z"));
    expect(toMs("2026-09-03T10:00:06-04:00")).toBe(Date.parse("2026-09-03T10:00:06-04:00"));
  });

  it("still promotes seconds, which is how a meeting once landed in the year 58652", () => {
    expect(toMs(1788750646)).toBe(1788750646000);
    expect(toMs(1788750646379)).toBe(1788750646379);
  });

  it("returns 0 for nothing, rather than 1970", () => {
    expect(toMs(undefined)).toBe(0);
    expect(toMs("not a date")).toBe(0);
  });
});

describe("toRecording — a real row", () => {
  it("maps the live shape onto what the pipeline already files by", () => {
    const r = toRecording(REAL);
    expect(r.id).toBe("3e531b8928ce0502927ac3b902c29c00");
    expect(r.title).toBe("2026-09-06 23:10:46");
    expect(r.startTime).toBe(Date.parse("2026-09-07T03:10:46.379Z"));
    // 31000 is thirty-one seconds. Multiplying it again would report a nine-hour meeting.
    expect(r.duration).toBe(31000);
    expect(r.stamp).toBe(stampFor(r.startTime));
  });

  it("falls back to a timestamp title when the recording has no name", () => {
    // Plaud names an unnamed recording after its clock, and so do we — the alternative is a
    // folder called "undefined" in somebody's second brain.
    const r = toRecording({ ...REAL, name: "   " });
    expect(r.title).toBe(stampFor(r.startTime));
  });

  it("uses created_at when start_at is missing", () => {
    const { start_at: _omit, ...noStart } = REAL;
    expect(toRecording(noStart).startTime).toBe(Date.parse("2026-09-07T03:11:13Z"));
  });
});
