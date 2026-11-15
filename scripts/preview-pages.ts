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
import type { BookingReceipt, Day, EventTypeSummary, Host, Week } from '../packages/public/src/views/types.ts';

const out = resolve(process.argv[2] ?? '.oil-ui/booking-ui/preview');
mkdirSync(out, { recursive: true });
cpSync(resolve('packages/public/assets'), join(out, 'assets'), { recursive: true });

const host: Host = { name: 'Tom Zhou' };
const base = 'https://meet.yuxingzhou.me';

const intro: EventTypeSummary = {
  slug: 'intro',
  title: 'Intro call',
  description: 'A first conversation: what you are working on and whether I can help.',
  durationMin: 30,
  location: 'Google Meet',
  mode: 'instant',
  href: '/intro.html',
};
const project: EventTypeSummary = {
  slug: 'project',
  title: 'Project deep-dive',
  description: 'For an ongoing project. Tell me a little about it when you book.',
  durationMin: 45,
  location: 'Google Meet',
  mode: 'approval',
  href: '/intro.html',
};
const quick: EventTypeSummary = {
  slug: 'quick',
  title: 'Quick question',
  description: '',
  durationMin: 15,
  location: 'Google Meet',
  mode: 'instant',
  href: '/intro.html',
};

function day(weekday: string, monthDay: string, times: string[]): Day {
  return {
    weekday,
    monthDay,
    slots: times.map((t) => ({ start: `2026-11-${monthDay.split(' ')[1]?.padStart(2, '0')}T${t}:00-08:00`, label: t, href: '/confirm.html' })),
  };
}

const week: Week = {
  label: 'Nov 16 – 22',
  prevHref: null,
  nextHref: '/intro.html',
  days: [
    day('Mon', 'Nov 16', ['14:00', '15:30', '16:00']),
    day('Tue', 'Nov 17', ['09:00', '09:30', '10:00', '11:30', '13:00', '14:30', '16:00']),
    day('Wed', 'Nov 18', ['10:00', '10:30', '15:00']),
    day('Thu', 'Nov 19', ['09:00', '11:00', '11:30', '13:30', '14:00', '15:30', '16:00', '16:30']),
    day('Fri', 'Nov 20', ['09:30', '10:00']),
  ],
};

const timezone = {
  current: 'America/Los_Angeles',
  options: ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Asia/Shanghai', 'Asia/Tokyo'],
  action: '/intro.html',
  hidden: { week: '2026-11-16' },
};

const agent = {
  copyLine: `Find a time for a 30-min intro call with Tom Zhou: ${base}/intro (open times and booking steps are on that page, no login; MCP: ${base}/mcp)`,
  pageUrl: `${base}/intro`,
  mcpUrl: `${base}/mcp`,
  slotsUrl: `${base}/api/slots`,
  bookingsUrl: `${base}/api/bookings`,
  slug: 'intro',
};

const chosen = { start: '2026-11-17T14:30:00-08:00', dateLine: 'Tuesday, November 17', timeLine: '14:30 – 15:00' };

const receipt = (over: Partial<BookingReceipt>): BookingReceipt => ({
  status: 'confirmed',
  title: 'Intro call',
  guestName: 'Maya Lindqvist',
  dateLine: 'Tuesday, November 17',
  timeLine: '14:30 – 15:00',
  timezone: 'America/Los_Angeles',
  location: 'Google Meet',
  meetUrl: 'https://meet.google.com/abc-defg-hij',
  cancelAction: '/status-cancelled.html',
  rescheduleHref: '/intro.html',
  reschedulesLeft: 2,
  note: null,
  ...over,
});

const pages: Record<string, string> = {
  'index.html': renderIndex({ host, eventTypes: [intro, project, quick] }),
  'intro.html': renderBooking({ host, eventType: intro, week, timezone, agent }),
  'intro-empty.html': renderBooking({ host, eventType: intro, week: { ...week, days: [] }, timezone, agent }),
  'reschedule.html': renderBooking({ host, eventType: intro, week, timezone, agent, rescheduling: { from: 'Tuesday, November 17 at 14:30' } }),
  'confirm.html': renderConfirm({
    host, eventType: project, chosen, timezone: 'America/Los_Angeles',
    questions: [{ id: 'about', label: 'What would you like to cover?', required: true, multiline: true }],
    values: { name: '', email: '', answers: {} }, errors: {}, retryToken: 'rt_preview', action: '/status-pending.html', backHref: '/intro.html',
  }),
  'confirm-errors.html': renderConfirm({
    host, eventType: intro, chosen, timezone: 'America/Los_Angeles', questions: [],
    values: { name: 'Maya', email: 'maya@', answers: {} }, errors: { email: 'Check the email address; it looks incomplete.' },
    retryToken: 'rt_preview', action: '/status-confirmed.html', backHref: '/intro.html',
    problem: { message: 'Someone booked 14:30 a moment ago. These nearby times are still open:', alternatives: [week.days[1]!.slots[4]!, week.days[1]!.slots[6]!, week.days[3]!.slots[0]!] },
  }),
  'status-pending.html': renderStatus({ host, receipt: receipt({ status: 'pending', title: 'Project deep-dive', timeLine: '14:30 – 15:15', meetUrl: null }), bookAgainHref: '/intro.html', flash: 'Request sent.' }),
  'status-confirmed.html': renderStatus({ host, receipt: receipt({}), bookAgainHref: '/intro.html' }),
  'status-nolink.html': renderStatus({ host, receipt: receipt({ meetUrl: null }), bookAgainHref: '/intro.html' }),
  'status-cancelled.html': renderStatus({ host, receipt: receipt({ status: 'cancelled', cancelAction: null, rescheduleHref: null, note: 'Cancelled on November 15.' }), bookAgainHref: '/intro.html' }),
};

for (const [name, markup] of Object.entries(pages)) writeFileSync(join(out, name), markup);
console.log(`Wrote ${Object.keys(pages).length} pages to ${out}`);
