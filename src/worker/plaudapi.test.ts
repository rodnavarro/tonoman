// Shapes taken from the live API, not from reading a client and guessing.
//
// The guesses were wrong in three places, and each would have failed quietly rather than loudly:
// the list envelope is `data` (not `items`), `start_at` is an ISO string (not epoch milliseconds),
// and `duration` is already milliseconds. A recording parsed with any of those wrong still
// produces a Recording object — with the wrong date, which is exactly the kind of bug that reaches
// a customer's second brain before anyone notices.

import { describe, expect, it } from "vitest";
import { toMs, toRecording, stampFor, envelopeError } from "./plaudapi";

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

describe("envelopeError — the 200 that was a failure", () => {
  it("catches the exact body a dead credential returns", () => {
    // Copied from the live API, not invented. This is what a poll saw every two minutes for hours
    // while reporting success: HTTP 200, no `data_file_list`, an empty recording list, and a
    // person waiting for a recap that was never going to come.
    const r = envelopeError({ status: -419, msg: "workspace token expired" });
    expect(r).toBeDefined();
    // The message has to name the ACTION. "workspace token expired" is Plaud's wording and tells
    // the person nothing they can do about it.
    expect(r).toContain("!connect plaud");
    expect(r).toContain("workspace token expired");
  });

  it("leaves a normal response alone", () => {
    // The check must be invisible in the healthy case, or it becomes the new silent failure.
    expect(envelopeError({ data_file_list: [{ id: "1" }] })).toBeUndefined();
    expect(envelopeError({ status: 0, data_file_list: [] })).toBeUndefined();
    expect(envelopeError({ status: 200 })).toBeUndefined();
    expect(envelopeError([])).toBeUndefined();
    expect(envelopeError(null)).toBeUndefined();
    expect(envelopeError(undefined)).toBeUndefined();
  });

  it("reports a negative status it has no wording for, rather than swallowing it", () => {
    // An unrecognised error is still an error. Returning undefined here would restore exactly the
    // behaviour this function exists to end.
    expect(envelopeError({ status: -1 })).toBe("status -1");
    expect(envelopeError({ status: -3, msg: "rate limited" })).toBe("rate limited");
  });

  it("treats every wording for a dead credential as one that needs reconnecting", () => {
    for (const msg of ["workspace token expired", "unauthorized", "invalid token", "not logged in"]) {
      expect(envelopeError({ status: -1, msg })).toContain("!connect plaud");
    }
  });
});
