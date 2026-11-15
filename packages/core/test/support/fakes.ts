import { Temporal } from 'temporal-polyfill';
import { deriveKeys } from '../../src/crypto.ts';
import type { CoreContext } from '../../src/bookings.ts';
import { ensureDefaultSchedule, createEventType } from '../../src/catalog.ts';
import { ProviderUnavailable, type CalendarEvent, type CalendarProvider, type MeetProvider, type NewEvent } from '../../src/providers.ts';
import { sqliteDb } from './sqlite-db.ts';

export const LA = 'America/Los_Angeles';
export const at = (local: string) => Temporal.PlainDateTime.from(local).toZonedDateTime(LA).epochMilliseconds;
export const iso = (local: string) => Temporal.PlainDateTime.from(local).toZonedDateTime(LA).toString({ timeZoneName: 'never' });

export class ManualClock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

/** An Outlook calendar in memory. Each step can be made to fail. */
export class FakeCalendar implements CalendarProvider {
  events = new Map<string, CalendarEvent & { subject?: string; attendee?: NewEvent['attendee']; body?: string; location?: string; cancelled?: boolean }>();
  created: NewEvent[] = [];
  fail = { list: false, create: false, createThenTimeout: false, update: false };
  private next = 1;

  addBusy(start: number, end: number) {
    const id = `ext-${this.next++}`;
    this.events.set(id, { id, transactionId: null, start, end, busy: true });
  }
  async listEvents(from: number, to: number) {
    if (this.fail.list) throw new ProviderUnavailable('microsoft', 'down');
    return [...this.events.values()].filter((e) => !e.cancelled && e.start < to && e.end > from).map((e) => ({ ...e }));
  }
  async createEvent(e: NewEvent) {
    if (this.fail.create) throw new ProviderUnavailable('microsoft', 'down');
    // Graph refuses a second create with the same transactionId.
    const dup = [...this.events.values()].find((x) => x.transactionId === e.transactionId && !x.cancelled);
    if (dup) return { id: dup.id };
    const id = `evt-${this.next++}`;
    this.events.set(id, { id, transactionId: e.transactionId, start: e.start, end: e.end, busy: true, subject: e.subject, attendee: e.attendee, body: e.body, location: e.location });
    this.created.push(e);
    if (this.fail.createThenTimeout) throw new ProviderUnavailable('microsoft', 'timed out after creating');
    return { id };
  }
  async updateEvent(id: string, patch: Partial<NewEvent>) {
    if (this.fail.update) throw new ProviderUnavailable('microsoft', 'down');
    const e = this.events.get(id);
    if (e) Object.assign(e, patch);
  }
  async deleteEvent(id: string) {
    this.events.delete(id);
  }
  async cancelEvent(id: string) {
    const e = this.events.get(id);
    if (e) e.cancelled = true;
  }
  live() {
    return [...this.events.values()].filter((e) => !e.cancelled && e.transactionId);
  }
}

export class FakeMeet implements MeetProvider {
  fail = false;
  rooms = 0;
  async createSpace() {
    if (this.fail) throw new ProviderUnavailable('google', 'down');
    this.rooms++;
    return { url: `https://meet.google.com/room-${this.rooms}` };
  }
}

export async function setup(options: { now?: string } = {}) {
  const db = sqliteDb();
  const clock = new ManualClock(at(options.now ?? '2026-11-15T08:00'));
  const calendar = new FakeCalendar();
  const meet = new FakeMeet();
  const keys = await deriveKeys(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  const background: Promise<unknown>[] = [];
  const ctx: CoreContext = {
    db, keys, clock, calendar, meet,
    config: { publicUrl: 'https://meet.example', ownerUrl: 'https://meet-mcp.example', ownerName: 'Tom Zhou', ownerTimezone: LA },
    background: (p) => background.push(p),
  };
  await ensureDefaultSchedule(db, clock.now(), LA);
  await createEventType(db, clock.now(), { slug: 'intro', title: 'Intro call', confirmation: 'instant', min_notice_min: 0 });
  await createEventType(db, clock.now(), { slug: 'project', title: 'Project deep-dive', lengths: [45], confirmation: 'approval', min_notice_min: 0 });
  return { db, clock, calendar, meet, ctx, background };
}

let n = 0;
export function request(slug: string, local: string, over: Record<string, unknown> = {}) {
  n++;
  return { event_type: slug, start: iso(local), name: 'Maya Lindqvist', email: `maya${n}@example.com`, timezone: 'Europe/Stockholm', retry_token: `token-${n}-abcdef`, ...over };
}
