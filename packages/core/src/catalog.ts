import {
  CreateEventTypeInput,
  DateOverride,
  DuplicateEventTypeInput,
  EventTypeSettings,
  Schedule,
  UpdateEventTypeInput,
  applySettingsChanges,
} from '@wellmet/contracts';
import type { Db } from './db.ts';
import { CoreError, invalid } from './errors.ts';
import { newId } from './crypto.ts';

/**
 * Event types, schedules and date overrides: everything the owner configures
 * through his agent. Every write is validated against the shared schemas.
 */

export interface EventTypeRecord {
  slug: string;
  active: boolean;
  settings: EventTypeSettings;
  updatedAt: number;
}

interface EventTypeRow {
  slug: string;
  settings: string;
  active: number;
  updated_at: number;
}

function toRecord(row: EventTypeRow): EventTypeRecord {
  return { slug: row.slug, active: row.active === 1, settings: EventTypeSettings.parse(JSON.parse(row.settings)), updatedAt: row.updated_at };
}

// --- Event types ----------------------------------------------------------------

export async function listEventTypes(db: Db, options: { includeArchived?: boolean; publicOnly?: boolean } = {}): Promise<EventTypeRecord[]> {
  const { results } = await db.prepare('SELECT slug, settings, active, updated_at FROM event_types ORDER BY created_at').all<EventTypeRow>();
  return results
    .map(toRecord)
    .filter((t) => options.includeArchived || t.active)
    .filter((t) => !options.publicOnly || (t.active && t.settings.visibility === 'listed'));
}

export async function getEventType(db: Db, slug: string): Promise<EventTypeRecord | null> {
  const row = await db.prepare('SELECT slug, settings, active, updated_at FROM event_types WHERE slug = ?').bind(slug).first<EventTypeRow>();
  return row ? toRecord(row) : null;
}

export async function requireEventType(db: Db, slug: string): Promise<EventTypeRecord> {
  const t = await getEventType(db, slug);
  if (!t) throw new CoreError('not_found', `There is no event type "${slug}". Use list_event_types to see the slugs.`);
  return t;
}

async function requireSchedule(db: Db, id: string): Promise<void> {
  const row = await db.prepare('SELECT id FROM schedules WHERE id = ?').bind(id).first();
  if (!row) throw new CoreError('unknown_schedule', `There is no schedule "${id}". Create it with upsert_schedule, or use one from list_schedules.`);
}

export async function createEventType(db: Db, now: number, input: unknown): Promise<EventTypeRecord> {
  const parsed = CreateEventTypeInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const { slug, ...rest } = parsed.data;
  const settings = EventTypeSettings.safeParse(rest);
  if (!settings.success) throw invalid(settings.error.issues);
  await requireSchedule(db, settings.data.schedule);
  if (await getEventType(db, slug)) throw new CoreError('slug_taken', `"${slug}" is already used. Pick another slug, or change that type with update_event_type.`);
  await db
    .prepare('INSERT INTO event_types (slug, settings, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
    .bind(slug, JSON.stringify(settings.data), now, now)
    .run();
  return requireEventType(db, slug);
}

export async function updateEventType(db: Db, now: number, input: unknown): Promise<EventTypeRecord> {
  const parsed = UpdateEventTypeInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const current = await requireEventType(db, parsed.data.slug);
  const next = applySettingsChanges(current.settings, parsed.data.changes as Partial<EventTypeSettings>);
  if (!next.success) throw invalid(next.error.issues);
  await requireSchedule(db, next.data.schedule);
  await db
    .prepare('UPDATE event_types SET settings = ?, updated_at = ? WHERE slug = ?')
    .bind(JSON.stringify(next.data), now, parsed.data.slug)
    .run();
  return requireEventType(db, parsed.data.slug);
}

export async function duplicateEventType(db: Db, now: number, input: unknown): Promise<EventTypeRecord> {
  const parsed = DuplicateEventTypeInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const source = await requireEventType(db, parsed.data.from);
  const next = applySettingsChanges(source.settings, (parsed.data.changes ?? {}) as Partial<EventTypeSettings>);
  if (!next.success) throw invalid(next.error.issues);
  return createEventType(db, now, { slug: parsed.data.slug, ...next.data });
}

/** Archived types take no new bookings and disappear from public lists. Existing bookings are kept. */
export async function setArchived(db: Db, now: number, slug: string, archived: boolean): Promise<EventTypeRecord> {
  await requireEventType(db, slug);
  await db.prepare('UPDATE event_types SET active = ?, updated_at = ? WHERE slug = ?').bind(archived ? 0 : 1, now, slug).run();
  return requireEventType(db, slug);
}

// --- Schedules --------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  name: string;
  timezone: string;
  weekly: string;
}

export async function listSchedules(db: Db): Promise<Schedule[]> {
  const { results } = await db.prepare('SELECT id, name, timezone, weekly FROM schedules ORDER BY id').all<ScheduleRow>();
  return results.map((r) => Schedule.parse({ id: r.id, name: r.name, timezone: r.timezone, weekly: JSON.parse(r.weekly) }));
}

export async function getSchedule(db: Db, id: string): Promise<Schedule> {
  const r = await db.prepare('SELECT id, name, timezone, weekly FROM schedules WHERE id = ?').bind(id).first<ScheduleRow>();
  if (!r) throw new CoreError('unknown_schedule', `There is no schedule "${id}".`);
  return Schedule.parse({ id: r.id, name: r.name, timezone: r.timezone, weekly: JSON.parse(r.weekly) });
}

export async function upsertSchedule(db: Db, now: number, input: unknown): Promise<Schedule> {
  const parsed = Schedule.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const s = parsed.data;
  await db
    .prepare(
      `INSERT INTO schedules (id, name, timezone, weekly, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone, weekly = excluded.weekly, updated_at = excluded.updated_at`,
    )
    .bind(s.id, s.name, s.timezone, JSON.stringify(s.weekly), now)
    .run();
  return s;
}

/** The first schedule, created at setup: weekdays 9 to 5 in the owner's timezone. */
export async function ensureDefaultSchedule(db: Db, now: number, timezone: string): Promise<void> {
  const exists = await db.prepare("SELECT id FROM schedules WHERE id = 'default'").first();
  if (exists) return;
  const nineToFive = [{ start: '09:00', end: '17:00' }];
  await upsertSchedule(db, now, {
    id: 'default',
    name: 'Weekdays',
    timezone,
    weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive, sat: [], sun: [] },
  });
}

// --- Date overrides ---------------------------------------------------------------

interface OverrideRow {
  id: string;
  date: string;
  schedule: string;
  scope: string;
  kind: 'closed' | 'open';
  hours: string | null;
  note: string | null;
}

export type StoredOverride = DateOverride & { id: string };

function toOverride(r: OverrideRow): StoredOverride {
  const base = { id: r.id, date: r.date, schedule: r.schedule, scope: JSON.parse(r.scope), ...(r.note ? { note: r.note } : {}) };
  return r.kind === 'closed'
    ? { ...base, kind: 'closed' }
    : { ...base, kind: 'open', hours: JSON.parse(r.hours ?? '[]') };
}

export async function listOverrides(db: Db, fromDate: string, toDate: string, schedule?: string): Promise<StoredOverride[]> {
  const { results } = await db
    .prepare(`SELECT id, date, schedule, scope, kind, hours, note FROM date_overrides
              WHERE date >= ? AND date <= ? AND (? IS NULL OR schedule = ?) ORDER BY date, created_at`)
    .bind(fromDate, toDate, schedule ?? null, schedule ?? null)
    .all<OverrideRow>();
  return results.map(toOverride);
}

export async function setOverride(db: Db, now: number, input: unknown): Promise<StoredOverride> {
  const parsed = DateOverride.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const o = parsed.data;
  await requireSchedule(db, o.schedule);
  const id = newId();
  await db
    .prepare('INSERT INTO date_overrides (id, date, schedule, scope, kind, hours, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, o.date, o.schedule, JSON.stringify(o.scope), o.kind, o.kind === 'open' ? JSON.stringify(o.hours) : null, o.note ?? null, now)
    .run();
  return { ...o, id };
}

export async function removeOverride(db: Db, id: string): Promise<void> {
  const r = await db.prepare('DELETE FROM date_overrides WHERE id = ?').bind(id).run();
  if (r.meta.changes === 0) throw new CoreError('not_found', `There is no date override "${id}".`);
}
