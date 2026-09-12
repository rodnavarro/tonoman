// Which meeting a recording was.
//
// A recording arrives with a start time and a title Plaud invented from the filename. A calendar
// says what was actually happening then — the meeting's real name, who was invited, and which
// recurring series it belongs to. That is the difference between filing a recap under
// `Meetings/2026-09-07-1442` and filing it under `foley-meetings/APIs/API-Team-Standup`.
//
// This module answers only "which events were happening around then". It deliberately does NOT
// pick one: picking is content's job, not time's. Two meetings can overlap, a recording can start
// in the gap between them, and the thing that actually knows which one this was is the transcript.
// So the candidates go into the summarising call and the model says which it was — the same
// decision the old pipeline reached after trying it the other way round.
//
// PURE, apart from `fetchIcs`. Everything else turns text and numbers into other numbers, which is
// what makes the windowing testable without a calendar server.
//
// --- On timezones, because this is where the old implementation was subtly wrong ---------------
//
// Matching happens in EPOCH MILLISECONDS, never in local wall-clock time, and therefore needs no
// timezone setting at all. The old pipeline localised everything to `America/New_York` and searched
// a local-day window, which needs a configured zone, gets DST transitions wrong at the boundary,
// and cannot represent a tenant whose meetings cross midnight anywhere else.
//
// An instant is an instant. A recording made at 18:42Z and a meeting starting at 18:42Z coincide
// regardless of what either party calls that moment. ICS carries enough zone information to resolve
// every event to an instant, and once resolved the zone is not needed again.
//
// A timezone IS still needed elsewhere — the second-brain folder name is a local date, and
// `stampFor` currently builds it in UTC — but that is a separate decision about naming, not about
// matching, and folding them together is what made the old one need a setting it should not have.

import * as https from "node:https";
import ICAL from "ical.js";

/** One occurrence of one event, resolved to instants. The shape every connector normalises to, so
 *  the matcher never learns which provider an event came from. */
export interface CalEvent {
  summary: string;
  /** Epoch milliseconds. */
  start: number;
  end: number;
  /** Display names. */
  attendees: string[];
  /** Real addresses, and the steadier way to identify who a meeting was with — a title gets
   *  renamed, an address does not. **Empty for a published Outlook ICS**, which strips them: that
   *  is the feed's behaviour, not a parsing failure, and code that treats empty as "no attendees"
   *  rather than "unknown" will draw the wrong conclusion. */
  attendeeEmails: string[];
  /** The SERIES identity, so a weekly 1:1 and a one-off with the same person stay apart, and
   *  renaming or moving an occurrence changes nothing. Empty when the feed does not publish it. */
  uid: string;
  location: string;
  /** Which connection this came from — kind and alias, so two Google calendars stay distinguishable
   *  in the candidate list a person reads. */
  source: { kind: string; alias: string };
}

export interface Source {
  kind: string;
  alias: string;
}

/** How far either side of a recording to look for events.
 *
 *  Generous on purpose. People start recording after a meeting has begun and stop before it ends,
 *  and a recording that begins two minutes late must still find the meeting it belongs to. Being
 *  generous costs nothing here because this only gathers CANDIDATES — the content decides, and
 *  offering it one extra wrong option is cheaper than withholding the right one. */
export const DEFAULT_PAD_MINUTES = 30;

/** A hard ceiling on iterations when expanding one recurring event.
 *
 *  Expansion always starts at the series' own DTSTART, because that is the only thing the rule is
 *  defined against. Reaching a window years later therefore costs one step per occurrence, and a
 *  daily series running since 2020 is a few thousand cheap date additions — fine, and the loop
 *  stops the moment an occurrence starts after the window anyway.
 *
 *  What this guards is a rule that never ADVANCES — a malformed RRULE whose iterator returns the
 *  same instant forever. That is an infinite loop inside the process that also serves
 *  conversations, so the agent stops answering. High enough not to truncate anything real, low
 *  enough to bound the damage. */
const MAX_ITERATIONS = 100_000;

/** How far BEFORE the window an occurrence may start and still be worth considering.
 *
 *  An event that began earlier and is still running overlaps the window — the all-day workshop a
 *  recording lands in the middle of. Occurrences older than this are SKIPPED rather than ending
 *  the scan, because the series continues past them. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** PURE: the search window around a recording. */
export function windowFor(
  startMs: number,
  endMs: number,
  padMinutes = DEFAULT_PAD_MINUTES,
): { from: number; to: number } {
  const pad = Math.max(0, padMinutes) * 60_000;
  // `endMs` is trusted only as far as it is sane. Plaud has sent a zero duration for a recording
  // still being written, and a window that ends before it begins silently matches nothing.
  const end = endMs > startMs ? endMs : startMs;
  return { from: startMs - pad, to: end + pad };
}

/** PURE: does an event overlap a window? Half-open on both sides, so a meeting that ends exactly
 *  when the window opens is not a candidate for it. */
export function overlaps(ev: { start: number; end: number }, from: number, to: number): boolean {
  return ev.start < to && ev.end > from;
}

/** PURE: is this title one the tenant said to ignore?
 *
 *  Case-insensitive substring, not a regex. These are written by a person into a settings row, and
 *  a regex there is a way to make a typo take down the calendar match with a syntax error nobody
 *  sees. "Focus Time", "Lunch", "Calendly Meeting Block" — blocks, not meetings. */
export function excluded(summary: string, patterns: string[] = []): boolean {
  const s = summary.toLowerCase();
  return patterns.some((p) => {
    const t = p.trim().toLowerCase();
    return t !== "" && s.includes(t);
  });
}

/** PURE: a cancelled meeting is not a meeting.
 *
 *  Two ways a feed says so, and both are seen in the wild: a `STATUS:CANCELLED` property, and — for
 *  feeds that do not publish STATUS — Outlook's habit of prefixing the subject with "Canceled:".
 *  Missing the second files a recap under a meeting that did not happen. */
export function isCancelled(summary: string, status: string | undefined): boolean {
  if ((status ?? "").toUpperCase() === "CANCELLED") return true;
  return /^cancell?ed[:\s]/i.test(summary.trim());
}

function attendeesOf(comp: ICAL.Component): { names: string[]; emails: string[] } {
  const names: string[] = [];
  const emails: string[] = [];
  for (const p of comp.getAllProperties("attendee")) {
    const raw = String(p.getFirstValue() ?? "");
    const email = raw.replace(/^mailto:/i, "").trim();
    const cn = String(p.getParameter("cn") ?? "").trim();
    if (email.includes("@") && !emails.includes(email)) emails.push(email);
    const name = cn || email;
    if (name && !names.includes(name)) names.push(name);
  }
  // Capped for the same reason the old pipeline capped it: an all-hands invite carries hundreds of
  // addresses, and none of them help identify the meeting. Twelve is enough to recognise a room.
  return { names: names.slice(0, 12), emails: emails.slice(0, 12) };
}

/** A default length for an event whose feed omits both DTEND and DURATION. Rare but legal, and
 *  treating it as zero-length would make it overlap nothing and vanish. */
const ASSUMED_MINUTES = 30;

function toEvent(
  comp: ICAL.Component,
  startMs: number,
  endMs: number,
  uid: string,
  source: Source,
): CalEvent | undefined {
  const summary = String(comp.getFirstPropertyValue("summary") ?? "").trim();
  if (!summary) return undefined;
  const status = comp.getFirstPropertyValue("status");
  if (isCancelled(summary, status ? String(status) : undefined)) return undefined;
  const { names, emails } = attendeesOf(comp);
  return {
    summary,
    start: startMs,
    end: endMs > startMs ? endMs : startMs + ASSUMED_MINUTES * 60_000,
    attendees: names,
    attendeeEmails: emails,
    uid,
    location: String(comp.getFirstPropertyValue("location") ?? "").trim(),
    source,
  };
}

/**
 * Parse an ICS document and return every occurrence overlapping `[from, to]`.
 *
 * Recurrence is expanded here rather than left to the caller, because "expand a recurring event"
 * is the entire difficulty of reading a calendar and getting it wrong is silent: a weekly standup
 * appears once, at whatever date the series began, and every later occurrence is simply absent.
 *
 * Never throws on a malformed feed. A calendar that fails to parse must degrade to "no calendar" —
 * the recap still gets filed, just without a meeting name — and not take the recording down with
 * it. The caller logs; the pipeline continues.
 */
export function eventsBetween(ics: string, from: number, to: number, source: Source): CalEvent[] {
  // Guarded rather than trusted. `ICAL.parse("")` does NOT throw — it yields a component with no
  // jCal behind it, and the failure surfaces later as a TypeError from inside the library. An
  // empty body is the ordinary result of a feed that 200s with nothing in it.
  if (ics.trim() === "") return [];
  let comps: ICAL.Component[];
  try {
    comps = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents("vevent");
  } catch {
    return [];
  }
  if (!Array.isArray(comps)) return [];

  // A published feed frequently carries a modified occurrence (RECURRENCE-ID) whose master series
  // falls outside the window it publishes. Those must still appear — an orphan override IS the
  // meeting that happened — so they are separated here and emitted standalone if unclaimed.
  const masters: ICAL.Component[] = [];
  const overrides: ICAL.Component[] = [];
  for (const c of comps) (c.hasProperty("recurrence-id") ? overrides : masters).push(c);

  const claimed = new Set<ICAL.Component>();
  const out: CalEvent[] = [];

  for (const comp of masters) {
    try {
      emitMaster(comp, overrides, claimed, from, to, source, out);
    } catch {
      // ONE unreadable event must not cost the whole calendar. Constructing the Event is not the
      // only thing that throws: `ev.startDate` parses lazily, so a single malformed DTSTART raises
      // on property ACCESS, which a constructor-only guard sails straight past.
      continue;
    }
  }

  for (const o of overrides) {
    if (claimed.has(o)) continue;
    try {
      const ev = new ICAL.Event(o);
      if (!ev.startDate || ev.startDate.isDate) continue;
      const s = ev.startDate.toJSDate().getTime();
      const e = ev.endDate ? ev.endDate.toJSDate().getTime() : s;
      if (!overlaps({ start: s, end: e }, from, to)) continue;
      const made = toEvent(o, s, e, ev.uid ?? "", source);
      if (made) out.push(made);
    } catch {
      continue;
    }
  }

  return out;
}

/** One master series (or one-off) expanded into `out`. Throws on a malformed event; the caller
 *  turns that into "skip this one, keep the calendar". */
function emitMaster(
  comp: ICAL.Component,
  overrides: ICAL.Component[],
  claimed: Set<ICAL.Component>,
  from: number,
  to: number,
  source: Source,
  out: CalEvent[],
): void {
  const ev = new ICAL.Event(comp);
  // All-day entries are holidays, birthdays and out-of-office markers. Nobody records one, and
  // keeping them means every recording on a public holiday matches "Labor Day".
  if (!ev.startDate || ev.startDate.isDate) return;

  if (!ev.isRecurring()) {
    const s = ev.startDate.toJSDate().getTime();
    const e = ev.endDate ? ev.endDate.toJSDate().getTime() : s;
    if (!overlaps({ start: s, end: e }, from, to)) return;
    const made = toEvent(comp, s, e, ev.uid ?? "", source);
    if (made) out.push(made);
    return;
  }

  for (const o of overrides) {
    if (String(o.getFirstPropertyValue("uid") ?? "") !== (ev.uid ?? "")) continue;
    try {
      ev.relateException(o);
      claimed.add(o);
    } catch {
      // An override the library will not attach is still a real meeting. Leaving it unclaimed
      // means it is emitted standalone by the caller rather than lost.
    }
  }

  // NO argument to iterator(). `ICAL.Event.iterator(t)` treats `t` as the series' DTSTART rather
  // than as a seek, so passing the window start silently re-anchors the rule: a BYDAY=MO series
  // asked to begin on a Sunday yields Sundays. It also breaks EXDATE and the exception overrides,
  // which are keyed to the real occurrence times and match nothing once those shift. Expanding
  // from DTSTART and skipping forward is the only correct reading.
  const it = ev.iterator();
  let n = 0;
  for (let t = it.next(); t && n < MAX_ITERATIONS; t = it.next(), n++) {
    const s = t.toJSDate().getTime();
    if (s > to) break; // ascending; nothing later can overlap
    if (s < from - LOOKBACK_MS) continue; // before the window, but the series continues
    const d = ev.getOccurrenceDetails(t);
    const ds = d.startDate.toJSDate().getTime();
    const de = d.endDate ? d.endDate.toJSDate().getTime() : ds;
    if (!overlaps({ start: ds, end: de }, from, to)) continue;
    // `d.item` is the OVERRIDE where one applies, so an occurrence that was renamed or moved
    // reports its own summary and attendees rather than the series'.
    const made = toEvent(d.item.component, ds, de, ev.uid ?? "", source);
    if (made) out.push(made);
  }
}

/**
 * PURE: the candidates for one recording, across every calendar the agent has.
 *
 * Sorted by start time, then by name, so the list a person reads and the list the model reads are
 * stable between polls. An unstable order would make the summarising prompt differ run to run for
 * no reason, which is both a cache miss and a source of unreproducible answers.
 */
export function candidatesFor(
  events: CalEvent[],
  from: number,
  to: number,
  opts: { exclude?: string[] } = {},
): CalEvent[] {
  return events
    .filter((e) => overlaps(e, from, to) && !excluded(e.summary, opts.exclude))
    .sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
}

/** PURE: how a candidate reads in the Overview and in the summarising prompt.
 *
 *  The same rendering for both on purpose. When a match looks wrong, the question is always "what
 *  was it choosing between", and that is only answerable if the page shows what the model saw. */
export function describe(e: CalEvent, now = (ms: number): string => new Date(ms).toISOString()): string {
  const who =
    e.attendees.length > 0 ? ` — ${e.attendees.slice(0, 6).join(", ")}` : "";
  const where = e.location ? ` (${e.location})` : "";
  return `${now(e.start)}–${now(e.end)}  ${e.summary}${where}${who}  [${e.source.kind}/${e.source.alias}]`;
}

/**
 * Fetch a published ICS feed.
 *
 * The URL IS the credential — a published Outlook or Google feed authenticates nobody and grants
 * anybody who has the link a read of the calendar. So it is stored as a secret and never logged,
 * and this function takes it as an argument rather than reading it from anywhere.
 *
 * No caching to disk. The old pipeline cached the raw ICS so re-runs worked offline, which was
 * right for a script on a laptop and wrong here: a file on the volume is exactly what moving
 * credentials into the registry removed, and the volume is RWO so a second worker could not read
 * it anyway. A poll every few minutes is one conditional GET against a CDN-backed feed.
 */
export function fetchIcs(url: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      // Published feeds redirect: Outlook's share link lands on a CDN, Google's on a signed path.
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        resolve(fetchIcs(new URL(loc, url).toString(), timeoutMs));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        // The status, never the URL. A failure that logged the link would put a working credential
        // in the pod's stdout, which is the one place it must not be.
        reject(new Error(`calendar feed returned HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("calendar feed timed out")));
    req.on("error", (e) => reject(new Error(`calendar feed failed: ${e.message}`)));
  });
}


/** One attached calendar, with its URL already resolved from the secret store. */
export interface CalendarFeed {
  kind: string;
  alias: string;
  url: string;
}

/**
 * Every event around a window, across every calendar an agent has.
 *
 * ONE BAD FEED MUST NOT COST THE OTHERS. A revoked share link, an expired token or a provider
 * having a bad afternoon should remove that calendar from the answer and nothing else — an agent
 * with a work calendar and a personal one still matches its work meetings while the personal one
 * is broken. Anything that throws here would instead take down the whole recap, which is a far
 * worse trade than a partial candidate list the model is already designed to cope with.
 */
export async function gather(
  feeds: CalendarFeed[],
  from: number,
  to: number,
  opts: {
    exclude?: string[];
    fetcher?: (url: string) => Promise<string>;
    log?: (message: string) => void;
  } = {},
): Promise<CalEvent[]> {
  const fetcher = opts.fetcher ?? fetchIcs;
  const out: CalEvent[] = [];
  // Sequential rather than parallel, deliberately: this runs inside a Temporal activity that is
  // already doing the expensive work, the feeds are few, and a burst of simultaneous requests to
  // the same provider is how a polling client gets rate-limited.
  for (const f of feeds) {
    try {
      const body = await fetcher(f.url);
      const events = eventsBetween(body, from, to, { kind: f.kind, alias: f.alias });
      out.push(...events);
    } catch (e) {
      // The alias, never the URL. A published feed's link IS its credential.
      opts.log?.(`calendar: ${f.kind}/${f.alias} could not be read — ${(e as Error).message}`);
    }
  }
  return candidatesFor(out, from, to, { exclude: opts.exclude });
}

// --- Proving a feed is the RIGHT feed ------------------------------------------------------------

/** How far ahead to look when checking a feed. Long enough that a calendar with only a weekly
 *  meeting on it still shows something, short enough that the answer means "current". */
const PROBE_DAYS = 30;

/** What a person is told after attaching a calendar. */
export interface FeedHealth {
  ok: boolean;
  /** Events found in the probe window. Zero is suspicious, not fatal — see `warning`. */
  events: number;
  /** The soonest one. This is the field that actually proves anything: a count says a calendar was
   *  reached, a NAME says it is the calendar they meant. */
  next?: { summary: string; start: number };
  /** Set when the feed answered but the answer is not reassuring. */
  warning?: string;
  /** Set when it did not work at all. Written for the person who pasted the link. */
  problem?: string;
}

/**
 * Fetch a feed and say something a human can judge.
 *
 * The point is NOT "did an HTTP request succeed". A wrong-but-valid calendar, an empty one, and a
 * revoked share link that now serves a sign-in page all return happily at the transport level and
 * then quietly match nothing forever. The recap keeps getting filed, just never with a meeting
 * name, and there is nothing to notice.
 *
 * So this reports the next meeting BY NAME. A count proves a calendar was reached; a name is the
 * only thing that proves it is the right one.
 */
export async function checkIcs(
  url: string,
  now: number = Date.now(),
  fetcher: (u: string) => Promise<string> = fetchIcs,
): Promise<FeedHealth> {
  let body: string;
  try {
    body = await fetcher(url);
  } catch (e) {
    return { ok: false, events: 0, problem: (e as Error).message };
  }

  // A published link that has been revoked or needs re-publishing serves a sign-in PAGE, with a
  // cheerful 200. Saying "that link returns a web page, not a calendar" points at the actual
  // problem; "0 events" would send somebody to look at their calendar instead of their link.
  if (!/BEGIN:VCALENDAR/i.test(body)) {
    return {
      ok: false,
      events: 0,
      problem:
        "that link returned a web page rather than a calendar — the share link may have been revoked, or need re-publishing",
    };
  }

  const to = now + PROBE_DAYS * 24 * 60 * 60 * 1000;
  const events = eventsBetween(body, now, to, { kind: "ics", alias: "probe" });
  if (events.length === 0) {
    // Reachable and real, but nothing to match against. Usually the wrong calendar, occasionally a
    // genuinely empty month — so a warning rather than a refusal.
    return {
      ok: true,
      events: 0,
      warning: `no events in the next ${PROBE_DAYS} days — is this the calendar you meant?`,
    };
  }
  const soonest = events.reduce((a, b) => (a.start <= b.start ? a : b));
  return { ok: true, events: events.length, next: { summary: soonest.summary, start: soonest.start } };
}

/** PURE: how the health reads in a channel.
 *
 *  Deliberately concrete. "Connected." tells somebody nothing they can check; naming the next
 *  meeting lets them recognise their own calendar at a glance, which is the whole point of doing a
 *  check rather than just saving the URL. */
export function healthLine(name: string, h: FeedHealth): string {
  if (!h.ok) return `Could not read *${name}*: ${h.problem}`;
  if (h.events === 0) return `Connected *${name}*, but ${h.warning}`;
  const when = h.next ? new Date(h.next.start).toISOString().replace("T", " ").slice(0, 16) : "";
  const next = h.next ? ` Next up: *${h.next.summary}* at ${when} UTC.` : "";
  return `Connected *${name}* — ${h.events} event${h.events === 1 ? "" : "s"} in the next ${PROBE_DAYS} days.${next}`;
}
