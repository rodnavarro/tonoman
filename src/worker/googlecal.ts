// Google Calendar, read into the same CalEvent shape an ICS feed produces — so matching, the agenda
// brief and the recap page never learn which provider an event came from.
//
// The access token comes from the registry (`/oauth/google/<alias>/access-token`), which refreshes it
// with the client secret this worker never holds. Recurring events are expanded by Google itself
// (`singleEvents=true`), which is the reason not to parse RRULEs here.

import type { CalEvent, Source } from "./calendar";

/** The parts of a Google event this reads. */
export interface GoogleEvent {
  id?: string;
  iCalUID?: string;
  recurringEventId?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean }[];
}

/** An event whose feed gives no end is treated as this long, the same default the ICS path uses. */
const DEFAULT_LENGTH_MS = 30 * 60 * 1000;

/** PURE: Google's events as CalEvents.
 *
 *  Same rules as the ICS path, and as the original pipeline: all-day entries are not meetings
 *  (`date` rather than `dateTime`), cancelled ones did not happen, an untitled one cannot be
 *  matched by name. Attendees leave out the calendar's owner (`self`) and rooms (`resource`), and
 *  are capped at twelve — enough to recognise a room of people. */
export function eventsFromGoogle(items: GoogleEvent[], source: Source): CalEvent[] {
  const out: CalEvent[] = [];
  for (const e of items) {
    if ((e.status ?? "").toLowerCase() === "cancelled") continue;
    const summary = (e.summary ?? "").trim();
    if (!summary) continue;
    if (!e.start?.dateTime) continue; // all-day, or malformed
    const start = Date.parse(e.start.dateTime);
    if (!Number.isFinite(start)) continue;
    const parsedEnd = e.end?.dateTime ? Date.parse(e.end.dateTime) : NaN;
    const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + DEFAULT_LENGTH_MS;
    const people = (e.attendees ?? []).filter((a) => !a.self && !a.resource);
    const attendees: string[] = [];
    const attendeeEmails: string[] = [];
    for (const a of people) {
      const email = (a.email ?? "").trim().toLowerCase();
      const name = (a.displayName ?? "").trim() || email;
      if (name && !attendees.includes(name)) attendees.push(name);
      if (email && !attendeeEmails.includes(email)) attendeeEmails.push(email);
    }
    out.push({
      summary,
      start,
      end,
      attendees: attendees.slice(0, 12),
      attendeeEmails: attendeeEmails.slice(0, 12),
      // The SERIES identity for a recurring event, so every occurrence of a weekly meeting shares it.
      uid: e.recurringEventId || e.iCalUID || e.id || "",
      location: (e.location ?? "").trim(),
      source: { kind: source.kind, alias: source.alias },
    });
  }
  return out;
}

/** Every event overlapping [from, to) on the account's primary calendar, all pages of them. */
export async function listEvents(
  accessToken: string,
  from: number,
  to: number,
  fetchImpl: typeof fetch = fetch,
  calendarId = "primary",
): Promise<GoogleEvent[]> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  // Bounded: a calendar with thousands of events in one window is a misconfigured query, not a day.
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const r = await fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
      { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) },
    );
    if (!r.ok) throw new Error(`Google Calendar answered ${r.status}`);
    const j = (await r.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    items.push(...(j.items ?? []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return items;
}
