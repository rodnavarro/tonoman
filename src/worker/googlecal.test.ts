import { describe, expect, it } from "vitest";
import { eventsFromGoogle, listEvents, type GoogleEvent } from "./googlecal";
import { gather } from "./calendar";

const SRC = { kind: "google", alias: "personal" };

describe("eventsFromGoogle — Google's events in the shape every calendar uses", () => {
  const base: GoogleEvent = {
    id: "e1",
    summary: "Acme weekly",
    start: { dateTime: "2026-09-17T14:00:00-04:00" },
    end: { dateTime: "2026-09-17T14:30:00-04:00" },
  };

  it("maps a timed event to instants, with its source", () => {
    const [e] = eventsFromGoogle([base], SRC);
    expect(e).toMatchObject({
      summary: "Acme weekly",
      start: Date.parse("2026-09-17T18:00:00Z"),
      end: Date.parse("2026-09-17T18:30:00Z"),
      source: SRC,
    });
  });

  it("skips all-day, cancelled and untitled entries, as the original pipeline did", () => {
    const out = eventsFromGoogle(
      [
        { ...base, id: "allday", start: { date: "2026-09-17" }, end: { date: "2026-09-18" } },
        { ...base, id: "gone", status: "cancelled" },
        { ...base, id: "blank", summary: "  " },
        base,
      ],
      SRC,
    );
    expect(out.map((e) => e.summary)).toEqual(["Acme weekly"]);
  });

  it("leaves out the calendar's owner and rooms, keeps names, lowercases emails", () => {
    const [e] = eventsFromGoogle(
      [
        {
          ...base,
          attendees: [
            { email: "rod@example.com", self: true },
            { email: "Room-4@resource.calendar.google.com", resource: true },
            { email: "Priya@Example.com", displayName: "Priya Raman" },
            { email: "noname@example.com" },
          ],
        },
      ],
      SRC,
    );
    expect(e!.attendees).toEqual(["Priya Raman", "noname@example.com"]);
    expect(e!.attendeeEmails).toEqual(["priya@example.com", "noname@example.com"]);
  });

  it("uses the series id for a recurring occurrence, and a default length when there is no end", () => {
    const [e] = eventsFromGoogle([{ ...base, recurringEventId: "series-9", end: undefined }], SRC);
    expect(e!.uid).toBe("series-9");
    expect(e!.end - e!.start).toBe(30 * 60 * 1000);
  });
});

describe("listEvents — every page, expanded by Google", () => {
  it("asks for single events in the window and follows nextPageToken", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      const second = u.includes("pageToken=p2");
      return new Response(
        JSON.stringify(second ? { items: [{ id: "b" }] } : { items: [{ id: "a" }], nextPageToken: "p2" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const items = await listEvents("tok", 0, 3_600_000, fetchImpl);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(urls[0]).toContain("singleEvents=true");
    expect(urls[0]).toContain("calendars/primary/events");
  });

  it("throws on a refused request, so gather can skip that calendar and keep the others", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(listEvents("tok", 0, 1, fetchImpl)).rejects.toThrow(/401/);
  });
});

describe("gather with a Google calendar", () => {
  const ev = { summary: "1:1", start: 1_000, end: 2_000, attendees: [], attendeeEmails: [], uid: "", location: "", source: SRC };

  it("reads Google through its reader and applies the same exclusions", async () => {
    const out = await gather(
      [{ kind: "google", alias: "personal", url: "" }],
      0,
      10_000,
      {
        exclude: ["focus time"],
        google: async () => [ev, { ...ev, summary: "Focus Time" }],
      },
    );
    expect(out.map((e) => e.summary)).toEqual(["1:1"]);
  });

  it("skips a Google calendar when no reader is wired, and one that fails, without losing the rest", async () => {
    const logs: string[] = [];
    expect(await gather([{ kind: "google", alias: "personal", url: "" }], 0, 10_000)).toEqual([]);
    const out = await gather(
      [
        { kind: "google", alias: "broken", url: "" },
        { kind: "google", alias: "personal", url: "" },
      ],
      0,
      10_000,
      {
        google: async (f) => {
          if (f.alias === "broken") throw new Error("registry answered 502");
          return [ev];
        },
        log: (m) => logs.push(m),
      },
    );
    expect(out).toHaveLength(1);
    expect(logs.join(" ")).toContain("google/broken");
  });
});
