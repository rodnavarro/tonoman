// The worker's own tools a skill brings — `tonoman plaud`, `tonoman calendar`, `tonoman meeting-recap`
// (D-JOBS-ARE-PROMPTS in Tonoman Cloud). The agent calls them in a turn, as the person the turn is for,
// whether that person typed the message or a job wrote it on their behalf: chat and a scheduled run
// are the same agent doing the same thing. A login or a calendar is named by its LABEL, the way people
// say it ("Work calendar", "Team Plaud"); "mine" is the person's own.
//
// What is here is the deciding — which logins and calendars a person may use, which one a label
// means, whether a recap may be filed. The reading and filing themselves are the worker's (deps).

import type { AgentConfig } from "../config.js";
import type * as recap from "./recap.js";
import type * as calendar from "./calendar.js";
import type { CalEvent } from "./calendar.js";
import type { VoiceConfig } from "./activities.js";

/** The tool groups a skill brings to a turn, by skill. A skill not listed brings none of these. */
const GROUPS_OF: Record<string, string[]> = {
  "meeting-recap": ["plaud", "calendar", "meeting-recap"],
  "agenda-brief": ["calendar"],
};

/** PURE: the worker-served `tonoman` groups this agent's skills bring (CLI-GRANTED-GROUPS). */
export function localToolsOf(cfg: Pick<AgentConfig, "skills">): string[] {
  const out = new Set<string>();
  for (const t of cfg.skills ?? []) for (const g of GROUPS_OF[t.name] ?? []) out.add(g);
  return [...out];
}

/** PURE: what the agent is told about its skills each turn — each copy by keyword, what it does, and
 *  which logins and calendars its tools use, by label (D-JOBS-ARE-PROMPTS). Empty for no skills. */
export function skillsNote(cfg: Pick<AgentConfig, "skills">, describe: (skill: string) => string | undefined): string {
  const lines: string[] = [];
  for (const t of cfg.skills ?? []) {
    const word = t.instance ?? t.name;
    const uses: string[] = [];
    for (const [tool, b] of Object.entries(t.bindings ?? {})) {
      const shared = b.credentials.filter((c) => c.scope !== "per_person").map((c) => `"${c.label || c.alias}"`);
      const own = b.mode === "each_person" || b.credentials.some((c) => c.scope === "per_person");
      const what = [...(own ? ["each person's own (\"mine\")"] : []), ...shared];
      if (what.length) uses.push(`${tool}: ${what.join(", ")}`);
    }
    const about = describe(t.name);
    lines.push(`- \`${word}\`${word !== t.name ? ` (a copy of ${t.name})` : ""}${about ? ` — ${about}` : ""}${uses.length ? ` Uses ${uses.join("; ")}.` : ""}`);
  }
  if (!lines.length) return "";
  return ["## Your skills", "Each runs with `!skill <keyword>`. Its tools name a login or calendar by label; \"mine\" is the person's own.", ...lines].join("\n");
}

/** PURE: which skill copies the agent's one schedule runs at `at` (D-ONE-CLOCK-PER-AGENT): every
 *  meeting-recap copy with its schedule on, and each agenda-brief copy one of whose times this is
 *  (within a minute and a half). Nothing runs where nobody can be told. */
export function dueCopies(
  cfg: Pick<AgentConfig, "skills" | "timezone">,
  reach: boolean,
  at: number,
  times: (raw: unknown) => { hour: number; minute: number }[],
  localTimeOn: (ms: number, tz: string, hour: number, minute: number) => number,
): { recaps: string[]; agendas: string[] } {
  if (!reach) return { recaps: [], agendas: [] };
  const on = (cfg.skills ?? []).filter((t) => t.schedule_enabled !== false);
  const tz = cfg.timezone || "UTC";
  return {
    recaps: on.filter((t) => t.name === "meeting-recap").map((t) => t.instance ?? t.name),
    agendas: on
      .filter((t) => t.name === "agenda-brief")
      .filter((t) => times(t.config?.times).some((x) => Math.abs(at - localTimeOn(at, tz, x.hour, x.minute)) < 90_000))
      .map((t) => t.instance ?? t.name),
  };
}

/** PURE: where a copy's scheduled work starts — the later of the flow's floor and when it was added
 *  (SKILL-COPY-STARTS-NOW); a copy with no readable start starts now. */
export function copyFloor(flowFloorMs: number, since: string | undefined, now: number): number {
  const t = since ? Date.parse(since) : NaN;
  return Math.max(flowFloorMs, Number.isFinite(t) ? t : now);
}

/** One Plaud login a person may read here. */
export interface PlaudLogin {
  label: string;
  /** Their own, by Slack id; absent for a shared login. */
  user?: string;
  /** A shared login other than the voice flow's own: its sealed reference. */
  secretRef?: string;
}

/** PURE: the Plaud logins `speaker` may use on this agent. Their own when they connected one; and every
 *  shared login a skill copy here is set to use — or, with no copy set to one, the voice flow's own
 *  shared login, as before bindings. Never somebody else's own. */
export function plaudLogins(cfg: Pick<AgentConfig, "skills">, v: Pick<VoiceConfig, "accounts" | "creds"> | undefined, speaker: string): PlaudLogin[] {
  const out: PlaudLogin[] = [];
  if (v?.accounts?.some((a) => a.user === speaker)) out.push({ label: "mine", user: speaker });
  const shared = new Map<string, PlaudLogin>();
  for (const t of cfg.skills ?? []) {
    for (const c of t.bindings?.plaud?.credentials ?? []) {
      if (c.scope === "per_person" || !c.secret_ref) continue;
      const label = c.label || c.alias;
      shared.set(label.toLowerCase(), { label, secretRef: c.secret_ref });
    }
  }
  if (!shared.size && v && !(v.accounts?.length) && v.creds) shared.set("shared", { label: "shared" });
  return [...out, ...shared.values()];
}

/** PURE: which login `asked` names. Nothing, "mine", "my plaud" or "my own" is the person's own — or,
 *  when they have none and there is exactly one shared login, that one. Otherwise by label, ignoring
 *  case. A miss says what there is. */
export function pickLogin(logins: PlaudLogin[], asked: string | undefined): PlaudLogin | { error: string } {
  const a = (asked ?? "").trim().toLowerCase().replace(/[’']/g, "'");
  const names = logins.map((l) => `"${l.label}"`).join(", ") || "none";
  if (!a || a === "mine" || a === "my own" || a === "my plaud" || a === "own") {
    const mine = logins.find((l) => l.label === "mine");
    if (mine) return mine;
    const shared = logins.filter((l) => l.label !== "mine");
    if (shared.length === 1) return shared[0]!;
    return { error: shared.length ? `Name the login: --login with one of ${names}.` : "You have no Plaud login here. Connect yours with !connect plaud in a DM." };
  }
  const hit = logins.find((l) => l.label.toLowerCase() === a);
  return hit ?? { error: `No Plaud login called "${asked}" that you may use here. You can use: ${names}.` };
}

/** One calendar a person may read here. */
export interface CalendarChoice {
  label: string;
  kind: string;
  alias: string;
  secretRef?: string;
}

/** PURE: the calendars readable on this agent, by label — what any skill copy here is set to read, or,
 *  with no copy set to any, every connected calendar the agent holds, as before bindings. `copy` keeps
 *  it to one copy's (its run reads only its own). */
export function calendarChoices(cfg: Pick<AgentConfig, "skills" | "credentials">, copy?: string): CalendarChoice[] {
  const seen = new Map<string, CalendarChoice>();
  const add = (c: { kind: string; alias: string; label?: string; secret_ref?: string; status?: string }) => {
    if (c.kind !== "ics" && c.kind !== "google") return;
    if (c.status && c.status !== "connected") return;
    const label = c.label || `${c.kind} ${c.alias}`;
    seen.set(`${c.kind}:${c.alias}`, { label, kind: c.kind, alias: c.alias, secretRef: c.secret_ref });
  };
  const copies = (cfg.skills ?? []).filter((t) => !copy || (t.instance ?? t.name) === copy);
  const bound = copies.flatMap((t) => t.bindings?.calendar?.credentials ?? []);
  const anyBinding = copies.some((t) => t.bindings?.calendar);
  for (const c of anyBinding ? bound : (cfg.credentials ?? [])) add(c);
  return [...seen.values()];
}

/** PURE: the calendars `asked` (comma-separated labels) names; nothing asked is every one. */
export function pickCalendars(choices: CalendarChoice[], asked: string | undefined): CalendarChoice[] | { error: string } {
  const want = (asked ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!want.length) return choices;
  const out: CalendarChoice[] = [];
  for (const w of want) {
    const hit = choices.find((c) => c.label.toLowerCase() === w || c.alias.toLowerCase() === w);
    if (!hit) return { error: `No calendar called "${w}" here. You can read: ${choices.map((c) => `"${c.label}"`).join(", ") || "none"}.` };
    out.push(hit);
  }
  return out;
}

/** The recap a turn files, as the meeting-recap skill asks for it. */
export interface RecapIn {
  summary: string;
  highlights: string[];
  decisions: string[];
  followups: string[];
  participants?: string[];
  route?: string;
  routeReason?: string;
  meeting?: string;
  meetingReason?: string;
  alignment?: string;
  alignmentReason?: string;
}

const ALIGNMENTS = ["advances", "neutral", "detracts"];

/** PURE: is this recap fit to file? Every problem in one answer, so the agent fixes them at once
 *  (RECAP-CHECKED-BEFORE-FILED). A meeting must be one the calendar showed — or "" — so a name the
 *  model made up can never rename and misfile a recording (RECAP-NEVER-INVENTS). */
export function checkRecap(
  raw: unknown,
  o: { candidates: { summary: string }[]; routes?: string[]; fallback?: string; mission?: boolean },
): { recap: RecapIn } | { problems: string[] } {
  const problems: string[] = [];
  let r: Record<string, unknown> = {};
  if (typeof raw === "string") {
    const text = raw.trim();
    const open = text.indexOf("{");
    const close = text.lastIndexOf("}");
    try {
      r = JSON.parse(open >= 0 && close > open ? text.slice(open, close + 1) : text) as Record<string, unknown>;
    } catch {
      return { problems: ["the recap is not JSON — send one object: {\"summary\": …, \"highlights\": [...], …}"] };
    }
  } else if (raw && typeof raw === "object") {
    r = raw as Record<string, unknown>;
  } else {
    return { problems: ["no recap was sent — pass it with --recap or on stdin"] };
  }
  const strings = (k: string, max?: number) => {
    const v = r[k] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) problems.push(`"${k}" must be a list of strings`);
    else if (max && v.length > max) problems.push(`"${k}" has ${v.length}; at most ${max}`);
  };
  if (typeof r.summary !== "string" || !r.summary.trim()) problems.push(`"summary" is missing: 2 to 4 sentences`);
  strings("highlights", 5);
  strings("decisions");
  strings("followups");
  strings("participants");
  const meeting = typeof r.meeting === "string" ? r.meeting.trim() : "";
  if (meeting && !o.candidates.some((c) => c.summary.trim().toLowerCase() === meeting.toLowerCase())) {
    problems.push(
      `"meeting" must be one of the calendar entries exactly as written, or "": ${o.candidates.map((c) => `"${c.summary}"`).join(", ") || "there were none, so it must be \"\""}`,
    );
  }
  if (o.routes?.length) {
    const route = typeof r.route === "string" ? r.route : "";
    const allowed = [...o.routes, ...(o.fallback ? [o.fallback] : [])];
    if (!allowed.includes(route)) problems.push(`"route" must be one of: ${allowed.map((x) => `"${x}"`).join(", ")}`);
  }
  if (o.mission && r.alignment !== undefined && !ALIGNMENTS.includes(String(r.alignment))) problems.push(`"alignment" must be one of: ${ALIGNMENTS.join(", ")}`);
  if (problems.length) return { problems };
  return {
    recap: {
      summary: String(r.summary).trim(),
      highlights: (r.highlights as string[] | undefined) ?? [],
      decisions: (r.decisions as string[] | undefined) ?? [],
      followups: (r.followups as string[] | undefined) ?? [],
      participants: (r.participants as string[] | undefined) ?? [],
      ...(typeof r.route === "string" ? { route: r.route } : {}),
      ...(typeof r.routeReason === "string" ? { routeReason: r.routeReason } : {}),
      meeting,
      ...(typeof r.meetingReason === "string" ? { meetingReason: r.meetingReason } : {}),
      ...(o.mission && typeof r.alignment === "string" ? { alignment: r.alignment } : {}),
      ...(o.mission && typeof r.alignmentReason === "string" ? { alignmentReason: r.alignmentReason } : {}),
    },
  };
}

/** What the tools need from the worker. */
export interface LocalToolDeps {
  agentByGuid(guid: string): { name: string; cfg: AgentConfig } | undefined;
  voice(name: string): VoiceConfig | undefined;
  /** The Plaud credentials behind a login. */
  plaudCreds(name: string, login: PlaudLogin): Promise<recap.PlaudCreds | undefined>;
  listRecordings(creds: recap.PlaudCreds, limit: number): Promise<recap.Recording[]>;
  transcribe(name: string, creds: recap.PlaudCreds, rec: recap.Recording, user: string | undefined): Promise<recap.TranscribeResult>;
  /** Calendar feeds for these choices, URLs resolved. */
  feeds(name: string, cfg: AgentConfig, choices: CalendarChoice[]): Promise<calendar.CalendarFeed[]>;
  /** Every entry in the window, and the calendars that could not be read: said, never taken for an
   *  empty day (CONN-READ-FAILURE-NOT-ABSENCE). */
  gather(name: string, feeds: calendar.CalendarFeed[], from: number, to: number): Promise<{ events: CalEvent[]; unreadable: string[] }>;
  /** The day's facts, worded (the agenda brief's own arithmetic). */
  describeDay(events: CalEvent[], now: number, timeZone: string): string;
  /** File a recap; where it landed. */
  publish(
    name: string,
    user: string | undefined,
    p: { rec: recap.Recording; recap: RecapIn; transcript: string; candidates: CalEvent[]; by: string[] },
  ): Promise<{ published: boolean; path: string; route?: string }>;
  /** Close the run a job opened for this recording, as done (the post hook reads it). Best-effort. */
  closeRun(name: string, instance: string, recordingId: string, summary: string): Promise<void>;
  now?(): number;
}

type Answer = { status: number; text: string };

/** The tools, answered: the agent by guid, the person speaking, the group and command, the arguments. */
export function localTools(deps: LocalToolDeps) {
  // A transcript just made is what the filing a moment later reads, not a second transcription.
  const made = new Map<string, { rec: recap.Recording; text: string; by: string[] }>();
  const keep = (k: string, v: { rec: recap.Recording; text: string; by: string[] }) => {
    made.set(k, v);
    while (made.size > 24) made.delete(made.keys().next().value!);
  };
  const now = () => (deps.now ? deps.now() : Date.now());
  const iso = (ms: number) => new Date(ms).toISOString();
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

  return async function call(agentGuid: string, speaker: string, group: string, command: string, body: Record<string, unknown>): Promise<Answer> {
    const agent = deps.agentByGuid(agentGuid);
    if (!agent) return { status: 404, text: "This agent is not served here." };
    const { name, cfg } = agent;
    const v = deps.voice(name);

    if (group === "plaud" || (group === "meeting-recap" && command === "file")) {
      const logins = plaudLogins(cfg, v, speaker);
      if (group === "plaud" && command === "logins") {
        return { status: 200, text: logins.length ? logins.map((l) => `${l.label}${l.user ? " (your own)" : " (shared)"}`).join("\n") : "No Plaud login you may use here. Connect yours with !connect plaud in a DM." };
      }
      const login = pickLogin(logins, typeof body.login === "string" ? body.login : undefined);
      if ("error" in login) return { status: 400, text: login.error };
      const creds = await deps.plaudCreds(name, login);
      if (!creds) return { status: 409, text: `The Plaud login "${login.label}" is not connected. Connect it with !connect plaud in a DM.` };

      if (group === "plaud" && command === "list") {
        const recs = await deps.listRecordings(creds, 20);
        if (!recs.length) return { status: 200, text: `No recordings on "${login.label}".` };
        return { status: 200, text: recs.map((r) => `${r.id}  ${iso(r.startTime)}  ${minutes(r.duration)} min  ${r.title}`).join("\n") };
      }

      const id = String(body.id ?? "").trim();
      if (!id) return { status: 400, text: "Which recording? --id <id>, from tonoman plaud list." };
      const key = `${name}:${login.label}:${id}`;
      let got = made.get(key);
      if (!got) {
        const rec = (await deps.listRecordings(creds, 50)).find((r) => r.id === id);
        if (!rec) return { status: 404, text: `No recording ${id} on "${login.label}" among the newest 50.` };
        const t = await deps.transcribe(name, creds, rec, login.user);
        got = { rec, text: t.text, by: t.by };
        keep(key, got);
      }

      if (group === "plaud" && command === "transcript") {
        if (!got.text.trim()) return { status: 200, text: `"${got.rec.title}" has no speech in it. Nothing to recap: do not file it.` };
        return {
          status: 200,
          text: `Recording ${id}: "${got.rec.title}", started ${iso(got.rec.startTime)}, ${minutes(got.rec.duration)} min.\n\n${got.text}`,
        };
      }

      // meeting-recap file
      if (!got.text.trim()) return { status: 409, text: "That recording has no speech in it; it is not filed." };
      const copy = typeof body.copy === "string" && body.copy ? body.copy : "meeting-recap";
      const choices = calendarChoices(cfg, (cfg.skills ?? []).some((t) => (t.instance ?? t.name) === copy) ? copy : undefined);
      const feeds = await deps.feeds(name, cfg, choices);
      const pad = (v?.calendarPadMinutes ?? 30) * 60000;
      const candidates = feeds.length ? (await deps.gather(name, feeds, got.rec.startTime - pad, got.rec.startTime + got.rec.duration + pad)).events : [];
      const checked = checkRecap(body.recap, {
        candidates,
        routes: v?.journal?.routes.map((r) => r.id),
        fallback: v?.journal?.fallback,
        mission: !!v?.mission,
      });
      if ("problems" in checked) return { status: 400, text: `Not filed. Fix and send it again:\n- ${checked.problems.join("\n- ")}` };
      const filed = await deps.publish(name, login.user, { rec: got.rec, recap: checked.recap, transcript: got.text, candidates, by: got.by });
      if (!filed.published) return { status: 200, text: `Already filed at ${filed.path}; nothing changed.` };
      await deps.closeRun(name, copy, id, `Filed “${got.rec.title}” at ${filed.path}${filed.route ? ` (route ${filed.route})` : ""}.`).catch(() => {});
      return { status: 200, text: `Filed “${got.rec.title}” at ${filed.path}${filed.route ? ` (route ${filed.route})` : ""}.` };
    }

    if (group === "calendar") {
      const choices = calendarChoices(cfg);
      if (command === "list") {
        return { status: 200, text: choices.length ? choices.map((c) => `${c.label}  (${c.kind})`).join("\n") : "No calendar is connected here." };
      }
      const picked = pickCalendars(choices, typeof body.calendars === "string" ? body.calendars : undefined);
      if ("error" in picked) return { status: 400, text: picked.error };
      if (!picked.length) return { status: 200, text: "No calendar is connected here, so there is nothing to read." };
      const feeds = await deps.feeds(name, cfg, picked);
      const labelOf = (s?: { kind: string; alias: string }) => picked.find((c) => c.kind === s?.kind && c.alias === s?.alias)?.label ?? s?.alias ?? "";
      // A calendar that could not be read is not an empty one: the answer says so, by label.
      const unread = (u: string[]) =>
        u.length
          ? `\n\nCould not read: ${u.map((x) => picked.find((c) => `${c.kind}/${c.alias}` === x)?.label ?? x).join(", ")}, so this may be missing entries. Say so; do not call the day clear.`
          : "";
      if (command === "day") {
        const tz = cfg.timezone || "UTC";
        const t = now();
        const day = 24 * 60 * 60 * 1000;
        const { events, unreadable } = await deps.gather(name, feeds, t - day, t + day);
        return { status: 200, text: deps.describeDay(events, t, tz) + unread(unreadable) };
      }
      if (command === "find") {
        const from = Date.parse(String(body.from ?? ""));
        const to = Date.parse(String(body.to ?? ""));
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { status: 400, text: "--from and --to are ISO times, the first before the second." };
        const pad = (v?.calendarPadMinutes ?? 30) * 60000;
        const { events, unreadable } = await deps.gather(name, feeds, from - pad, to + pad);
        if (!events.length) return { status: 200, text: `Nothing on those calendars then.${unread(unreadable)}` };
        return {
          status: 200,
          text: events
            .map((e) => `"${e.summary}"  ${iso(e.start)} → ${iso(e.end)}  ${labelOf(e.source)}${e.attendees.length ? `  with ${e.attendees.slice(0, 8).join(", ")}` : ""}`)
            .join("\n") + unread(unreadable),
        };
      }
    }
    return { status: 404, text: `No command ${group} ${command}.` };
  };
}
