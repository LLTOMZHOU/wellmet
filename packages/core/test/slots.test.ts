import { describe, expect, it } from 'vitest';
import { Temporal } from 'temporal-polyfill';
import { CreateEventTypeInput, EventTypeSettings, Schedule, type DateOverride } from '@wellmet/contracts';
import { openSlots, weekKeyOf, type SlotQuery } from '../src/slots/engine.ts';

const LA = 'America/Los_Angeles';
/** Epoch ms for a wall-clock time in a timezone. */
const at = (local: string, tz = LA) => Temporal.PlainDateTime.from(local).toZonedDateTime(tz).epochMilliseconds;
/** Wall-clock "HH:MM" of each slot, in a timezone. */
const walls = (slots: { start: number }[], tz = LA) =>
  slots.map((s) => Temporal.Instant.fromEpochMilliseconds(s.start).toZonedDateTimeISO(tz).toPlainTime().toString({ smallestUnit: 'minute' }));

const weekdays9to12 = Schedule.parse({
  id: 'default',
  name: 'Weekdays',
  timezone: LA,
  weekly: {
    mon: [{ start: '09:00', end: '12:00' }],
    tue: [{ start: '09:00', end: '12:00' }],
    wed: [{ start: '09:00', end: '12:00' }],
    thu: [{ start: '09:00', end: '12:00' }],
    fri: [{ start: '09:00', end: '12:00' }],
  },
});

function query(over: Partial<Omit<SlotQuery, 'settings'>> & { settings?: Partial<EventTypeSettings> } = {}): SlotQuery {
  const settings = EventTypeSettings.parse({ title: 'Intro call', min_notice_min: 0, ...over.settings });
  return {
    slug: 'intro',
    lengthMin: settings.lengths[0]!,
    schedule: weekdays9to12,
    overrides: [],
    busy: [],
    bookedStarts: [],
    now: at('2026-11-15T08:00'), // a Sunday
    from: at('2026-11-16T00:00'),
    to: at('2026-11-17T00:00'),
    ...over,
    settings,
  };
}

describe('weekly hours', () => {
  it('offers every step that fits inside the range', () => {
    expect(walls(openSlots(query()))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('ends slots inside the range for longer meetings', () => {
    expect(walls(openSlots(query({ settings: { lengths: [60] }, lengthMin: 60 })))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('uses the step, not the length, for start times', () => {
    expect(walls(openSlots(query({ settings: { lengths: [30], slot_step_min: 60 } })))).toEqual(['09:00', '10:00', '11:00']);
  });

  it('offers nothing on a day with no hours', () => {
    expect(openSlots(query({ from: at('2026-11-21T00:00'), to: at('2026-11-23T00:00') }))).toEqual([]);
  });

  it('rejects a length the type does not offer', () => {
    expect(() => openSlots(query({ lengthMin: 45 }))).toThrow(/not offered/);
  });

  it('serves each offered length separately', () => {
    const settings = { lengths: [15, 60] };
    expect(openSlots(query({ settings, lengthMin: 15 }))).toHaveLength(6);
    expect(openSlots(query({ settings, lengthMin: 60 }))).toHaveLength(5);
  });
});

describe('notice and window', () => {
  it('hides starts sooner than the minimum notice', () => {
    const slots = openSlots(query({ settings: { min_notice_min: 120 }, now: at('2026-11-16T08:15') }));
    expect(walls(slots)[0]).toBe('10:30');
  });

  it('hides days beyond the booking window', () => {
    const slots = openSlots(query({ settings: { window_days: 2 }, from: at('2026-11-16T00:00'), to: at('2026-11-20T00:00') }));
    expect(new Set(slots.map((s) => s.localDate))).toEqual(new Set(['2026-11-16']));
  });
});

describe('busy time and buffers', () => {
  it('removes slots that overlap busy time', () => {
    const busy = [{ start: at('2026-11-16T10:00'), end: at('2026-11-16T10:30') }];
    expect(walls(openSlots(query({ busy })))).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('keeps this type\'s buffers clear of busy time', () => {
    const busy = [{ start: at('2026-11-16T10:00'), end: at('2026-11-16T10:30') }];
    const slots = openSlots(query({ busy, settings: { buffer_before_min: 15, buffer_after_min: 15 } }));
    expect(walls(slots)).toEqual(['09:00', '11:00', '11:30']);
  });

  it('allows a slot that ends exactly when busy time starts', () => {
    const busy = [{ start: at('2026-11-16T09:30'), end: at('2026-11-16T12:00') }];
    expect(walls(openSlots(query({ busy })))).toEqual(['09:00']);
  });
});

describe('caps', () => {
  it('closes a day once the daily cap is reached', () => {
    const slots = openSlots(query({
      settings: { limits: { per_day: 1 } },
      bookedStarts: [at('2026-11-16T15:00')],
      to: at('2026-11-18T00:00'),
    }));
    expect(new Set(slots.map((s) => s.localDate))).toEqual(new Set(['2026-11-17']));
  });

  it('closes the rest of the week once the weekly cap is reached', () => {
    const slots = openSlots(query({
      settings: { limits: { per_week: 2 } },
      bookedStarts: [at('2026-11-16T09:00'), at('2026-11-17T09:00')],
      to: at('2026-11-24T00:00'),
    }));
    expect(new Set(slots.map((s) => s.localDate))).toEqual(new Set(['2026-11-23']));
  });

  it('counts weeks from Monday', () => {
    expect(weekKeyOf('2026-11-22')).toBe('2026-11-16');
    expect(weekKeyOf('2026-11-23')).toBe('2026-11-23');
  });
});

describe('date overrides', () => {
  const closed: DateOverride = { kind: 'closed', date: '2026-11-16', schedule: 'default', scope: 'all' };
  const saturday: DateOverride = { kind: 'open', date: '2026-11-21', schedule: 'default', scope: ['intro'], hours: [{ start: '14:00', end: '15:00' }] };

  it('closes a date for every type', () => {
    expect(openSlots(query({ overrides: [closed] }))).toEqual([]);
  });

  it('opens a normally closed date with its own hours', () => {
    const slots = openSlots(query({ overrides: [saturday], from: at('2026-11-21T00:00'), to: at('2026-11-22T00:00') }));
    expect(walls(slots)).toEqual(['14:00', '14:30']);
  });

  it('applies a scoped override only to the types it names', () => {
    const q = { overrides: [saturday], from: at('2026-11-21T00:00'), to: at('2026-11-22T00:00') };
    expect(openSlots(query({ ...q, slug: 'project' }))).toEqual([]);
  });

  it('prefers an override naming the type over one for all types', () => {
    const allClosed: DateOverride = { ...closed, date: '2026-11-21' };
    const slots = openSlots(query({ overrides: [allClosed, saturday], from: at('2026-11-21T00:00'), to: at('2026-11-22T00:00') }));
    expect(walls(slots)).toEqual(['14:00', '14:30']);
  });

  it('ignores overrides for another schedule', () => {
    const other: DateOverride = { ...closed, schedule: 'deep-work' };
    expect(openSlots(query({ overrides: [other] }))).toHaveLength(6);
  });
});

describe('daylight saving', () => {
  const nights = Schedule.parse({
    id: 'default', name: 'Late', timezone: LA,
    weekly: { sun: [{ start: '01:00', end: '04:00' }] },
  });

  it('skips start times that do not exist when clocks go forward', () => {
    // 2027-03-14: 02:00 jumps to 03:00 in Los Angeles.
    const slots = openSlots(query({ schedule: nights, now: at('2027-03-13T00:00'), from: at('2027-03-14T00:00'), to: at('2027-03-15T00:00') }));
    expect(walls(slots)).toEqual(['01:00', '01:30', '03:00', '03:30']);
    expect(slots.every((s) => s.end - s.start === 30 * 60_000)).toBe(true);
  });

  it('offers each wall-clock time once when clocks go back, and keeps real lengths', () => {
    // 2026-11-01: 02:00 falls back to 01:00 in Los Angeles; the range is four real hours.
    const slots = openSlots(query({ schedule: nights, now: at('2026-10-31T00:00'), from: at('2026-11-01T00:00'), to: at('2026-11-02T00:00') }));
    expect(walls(slots)).toEqual(['01:00', '01:30', '02:00', '02:30', '03:00', '03:30']);
    expect(new Set(slots.map((s) => s.start)).size).toBe(slots.length);
    expect(slots.every((s) => s.end - s.start === 30 * 60_000)).toBe(true);
  });

  it('reports the date in the schedule\'s timezone, not UTC', () => {
    const evenings = Schedule.parse({ id: 'default', name: 'Evenings', timezone: LA, weekly: { mon: [{ start: '20:00', end: '22:00' }] } });
    const slots = openSlots(query({ schedule: evenings }));
    expect(slots[0]!.localDate).toBe('2026-11-16');
  });

  it('accepts 24:00 as the end of the day', () => {
    const late = Schedule.parse({ id: 'default', name: 'Late', timezone: LA, weekly: { mon: [{ start: '23:00', end: '24:00' }] } });
    expect(walls(openSlots(query({ schedule: late })))).toEqual(['23:00', '23:30']);
  });
});

describe('event type schema', () => {
  it('fills every default from just a slug and title', () => {
    const t = CreateEventTypeInput.parse({ slug: 'quick', title: 'Quick question' });
    expect(t).toMatchObject({
      lengths: [30], slot_step_min: 30, confirmation: 'approval', visibility: 'listed',
      location: { kind: 'google_meet' }, schedule: 'default', questions: [],
    });
  });

  it('explains a bad slug', () => {
    const r = CreateEventTypeInput.safeParse({ slug: 'Intro Call', title: 'x' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toMatch(/lowercase/);
  });

  it('requires Tom\'s number for a phone type', () => {
    expect(EventTypeSettings.safeParse({ title: 'Call', location: { kind: 'phone' } }).success).toBe(false);
    expect(EventTypeSettings.safeParse({ title: 'Call', location: { kind: 'phone', number: '+1 415 555 0100' } }).success).toBe(true);
  });

  it('has no option for Tom calling the guest', () => {
    const r = EventTypeSettings.safeParse({ title: 'Call', location: { kind: 'phone', number: '+1 415 555 0100', who_calls: 'host_calls_guest' } });
    expect(r.success && 'who_calls' in r.data.location).toBe(false);
  });

  it('rejects a daily cap above the weekly cap', () => {
    const r = EventTypeSettings.safeParse({ title: 'x', limits: { per_day: 5, per_week: 3 } });
    expect(r.success).toBe(false);
  });

  it('rejects overlapping hours in a schedule', () => {
    const r = Schedule.safeParse({ id: 'x', name: 'x', timezone: LA, weekly: { mon: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] } });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    expect(Schedule.safeParse({ id: 'x', name: 'x', timezone: 'Mars/Olympus', weekly: {} }).success).toBe(false);
  });
});
