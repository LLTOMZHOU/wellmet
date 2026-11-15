/**
 * Renders every public page and state with sample data into a folder, so the
 * design can be checked in a browser before the Workers exist.
 *
 *   npm run preview:pages -- <out-dir>
 *
 * Then serve <out-dir> with any static server; pages expect /assets at the root.
 */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderBooking, renderConfirm, renderIndex, renderStatus } from '../packages/public/src/views/pages.ts';
import type { BookingReceipt, CalendarDate, Day, EventTypeSummary, Host, Month } from '../packages/public/src/views/types.ts';

const out = resolve(process.argv[2] ?? '.oil-ui/booking-ui/preview');
mkdirSync(out, { recursive: true });
cpSync(resolve('packages/public/static/assets'), join(out, 'assets'), { recursive: true });

const host: Host = { name: 'Tom Zhou' };
const base = 'https://meet.yuxingzhou.me';

const intro: EventTypeSummary = {
  slug: 'intro', title: 'Intro call', durationMin: 30, location: 'Google Meet', mode: 'instant', href: '/intro.html',
  description: 'A first conversation: what you are working on and whether I can help.',
};
const project: EventTypeSummary = {
  slug: 'project', title: 'Project deep-dive', durationMin: 45, location: 'Google Meet', mode: 'approval', href: '/intro.html',
  description: 'For an ongoing project. Tell me a little about it when you book.',
};
const quick: EventTypeSummary = {
  slug: 'quick', title: 'Quick question', durationMin: 15, location: 'Google Meet', mode: 'instant', href: '/intro.html', description: '',
};

// November 2026: the 1st is a Sunday; "today" is the 15th.
const openTimes: Record<number, string[]> = {
  16: ['14:00', '15:30', '16:00'],
  17: ['09:00', '09:30', '10:00', '11:30', '13:00', '14:30', '16:00'],
  18: ['10:00', '10:30', '15:00'],
  19: ['09:00', '11:00', '11:30', '13:30', '14:00', '15:30', '16:00', '16:30'],
  20: ['09:30', '10:00'],
  23: ['09:00', '10:00', '13:00', '14:00', '16:00'],
  24: ['09:30', '11:00', '13:30', '14:30', '15:00', '16:30'],
  25: ['10:00', '11:00'],
  27: ['15:00'],
  30: ['09:00', '09:30', '10:30', '13:00', '14:00', '16:00'],
};
const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const slotsFor = (d: number) => (openTimes[d] ?? []).map((t) => ({
  start: `2026-11-${String(d).padStart(2, '0')}T${t}:00-08:00`, label: t, href: '/confirm.html',
}));
const dayView = (d: number): Day => {
  const weekday = weekdayNames[(d - 1) % 7]!;
  return { weekday, date: `${d} November`, short: `${weekday.slice(0, 3)} ${d}`, slots: slotsFor(d) };
};

function month(selected: number | null): Month {
  const dates: CalendarDate[] = [];
  for (let d = 1; d <= 30; d++) {
    const n = openTimes[d]?.length ?? 0;
    dates.push({
      day: d,
      date: `2026-11-${String(d).padStart(2, '0')}`,
      href: d >= 15 && n > 0 ? '/intro.html' : null,
      openCount: n,
      state: d < 15 ? 'past' : d === selected ? 'selected' : n > 0 ? 'open' : 'closed',
    });
  }
  return { label: 'November 2026', prevHref: null, prevLabel: 'Oct', nextHref: '/intro.html', nextLabel: 'Dec', leadingBlanks: 0, dates };
}

const upcoming = [15, 16, 17, 18, 19, 20, 21].map(dayView).filter((d) => d.slots.length > 0);

const timezone = {
  current: 'America/Los_Angeles',
  options: ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Asia/Shanghai', 'Asia/Tokyo'],
  action: '/intro.html',
  hidden: { date: '2026-11-17' },
};

const agent = {
  copyLine: `Find a time for a 30-min intro call with Tom Zhou: ${base}/intro (open times and booking steps are on that page, no login; MCP: ${base}/mcp)`,
  mcpUrl: `${base}/mcp`,
  slotsUrl: `${base}/api/slots`,
  bookingsUrl: `${base}/api/bookings`,
  slug: 'intro',
};

const chosen = { start: '2026-11-17T14:30:00-08:00', weekday: 'Tuesday', date: '17 November', timeLine: '14:30 – 15:00' };

const receipt = (over: Partial<BookingReceipt>): BookingReceipt => ({
  status: 'confirmed', title: 'Intro call', guestName: 'Maya Lindqvist',
  weekday: 'Tuesday', date: '17 November', timeLine: '14:30 – 15:00', timezone: 'America/Los_Angeles',
  location: 'Google Meet', meetUrl: 'https://meet.google.com/abc-defg-hij',
  cancelAction: '/status-cancelled.html', rescheduleHref: '/intro.html', reschedulesLeft: 2, note: null,
  ...over,
});

const pages: Record<string, string> = {
  'index.html': renderIndex({ host, eventTypes: [intro, project, quick], agent: { copyLine: 'Book a meeting with Tom Zhou: https://meet.yuxingzhou.me lists the kinds of meeting, open times and booking steps, no login needed (MCP: https://meet.yuxingzhou.me/mcp)' } }),
  'intro.html': renderBooking({ host, eventType: intro, month: month(17), selected: dayView(17), upcoming, timezone, agent }),
  'intro-closed-day.html': renderBooking({ host, eventType: intro, month: month(21), selected: dayView(21), upcoming, timezone, agent, nextOpen: { label: 'Monday 23 November', href: '/intro.html' } }),
  'reschedule.html': renderBooking({ host, eventType: intro, month: month(19), selected: dayView(19), upcoming, timezone, agent, rescheduling: { from: 'Tuesday 17 November at 14:30' } }),
  'confirm.html': renderConfirm({
    host, eventType: project, chosen: { ...chosen, timeLine: '14:30 – 15:15' }, timezone: 'America/Los_Angeles',
    questions: [{ id: 'about', label: 'What would you like to cover?', required: true, multiline: true }],
    values: { name: '', email: '', answers: {} }, errors: {}, retryToken: 'rt_preview', action: '/status-pending.html', backHref: '/intro.html',
  }),
  'confirm-errors.html': renderConfirm({
    host, eventType: intro, chosen, timezone: 'America/Los_Angeles', questions: [],
    values: { name: 'Maya', email: 'maya@', answers: {} }, errors: { email: 'Check the email address; it looks incomplete.' },
    retryToken: 'rt_preview', action: '/status-confirmed.html', backHref: '/intro.html',
    problem: { message: 'Someone booked 14:30 a moment ago. These nearby times are still open:', alternatives: [slotsFor(17)[4]!, slotsFor(17)[6]!, slotsFor(19)[0]!, slotsFor(19)[1]!] },
  }),
  'status-pending.html': renderStatus({ host, receipt: receipt({ status: 'pending', title: 'Project deep-dive', timeLine: '14:30 – 15:15', meetUrl: null }), bookAgainHref: '/intro.html', flash: 'Request sent.' }),
  'status-confirmed.html': renderStatus({ host, receipt: receipt({}), bookAgainHref: '/intro.html' }),
  'status-nolink.html': renderStatus({ host, receipt: receipt({ meetUrl: null }), bookAgainHref: '/intro.html' }),
  'status-cancelled.html': renderStatus({ host, receipt: receipt({ status: 'cancelled', cancelAction: null, rescheduleHref: null, note: 'Cancelled on 15 November.' }), bookAgainHref: '/intro.html' }),
};

for (const [name, markup] of Object.entries(pages)) writeFileSync(join(out, name), markup);
console.log(`Wrote ${Object.keys(pages).length} pages to ${out}`);
