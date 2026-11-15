import { Temporal } from 'temporal-polyfill';
import type { Caller, GuestBooking, PublicEventType, PublicSlot, Result } from '@wellmet/contracts';
import { handleMcp } from '@wellmet/contracts/mcp';
import { renderBooking, renderConfirm, renderIndex, renderMessage, renderMoveConfirm, renderPrivacy, renderStatus } from './views/pages.ts';
import type { BookingReceipt, CalendarDate, Day, EventTypeSummary, FieldErrors, Slot } from './views/types.ts';
import { STATUS, type Config, type PublicCore } from './core.ts';
import { TIMEZONE_CHOICES, dayMonth, hhmm, isoWithOffset, monthBounds, monthLabel, monthShort, validTimeZone, weekdayLong, weekdayShort, zoned } from './time.ts';
import { publicTools, PUBLIC_INSTRUCTIONS } from './agent.ts';

/**
 * wellmet-public's routes. No store, no secret: every answer comes from the
 * core's PublicApi. Pages work without JavaScript; every open time is a plain
 * link, so assistants that only read pages can see them.
 */

export interface RouteDeps {
  core: PublicCore;
  config: Config;
  /** Per-visitor rate limits (approximate). */
  limitRead: (source: string) => Promise<boolean>;
  limitWrite: (source: string) => Promise<boolean>;
}

const DAY = 86_400_000;
const host = (c: Config) => ({ name: c.ownerName });

const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const htmlResponse = (body: string, status = 200) => new Response(body, { status, headers: PAGE_HEADERS });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
const see = (location: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });

function apiError(r: Extract<Result<unknown>, { ok: false }>) {
  return json({ error: r.error }, STATUS[r.error.code] ?? 500);
}

export function callerOf(request: Request, via: Caller['via']): Caller {
  return { address: request.headers.get('cf-connecting-ip') ?? 'unknown', via };
}

/** The visitor's timezone: ?tz= if valid, else Cloudflare's guess from their address, else the type's own. */
export function visitorTz(request: Request, fallback: string): string {
  const fromQuery = new URL(request.url).searchParams.get('tz');
  if (validTimeZone(fromQuery)) return fromQuery;
  const fromCf = (request as Request & { cf?: { timezone?: string } }).cf?.timezone;
  return validTimeZone(fromCf) ? fromCf : fallback;
}

function summary(t: PublicEventType, lengthMin?: number): EventTypeSummary {
  return {
    slug: t.slug,
    title: t.title,
    description: t.description,
    durationMin: lengthMin ?? t.lengths[0]!,
    location: t.location.label,
    mode: t.confirmation,
    href: `/${t.slug}`,
  };
}

export function shareLine(c: Config, t: PublicEventType): string {
  return `Find a time for a ${t.lengths.join(' or ')}-min ${t.title.toLowerCase()} with ${c.ownerName}: ${c.publicUrl}/${t.slug} (open times and booking steps are on that page, no login; MCP: ${c.publicUrl}/mcp)`;
}

export function indexShareLine(c: Config): string {
  return `Book a meeting with ${c.ownerName}: ${c.publicUrl} lists the kinds of meeting, open times and booking steps, no login needed (MCP: ${c.publicUrl}/mcp)`;
}

// --- Router ----------------------------------------------------------------------------

export async function route(request: Request, deps: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const source = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const write = request.method === 'POST';
  if (!(await (write ? deps.limitWrite(source) : deps.limitRead(source)))) {
    return path.startsWith('/api/') || path === '/mcp'
      ? json({ error: { code: 'too_many_requests', message: 'Slow down: too many requests from here. Try again in a minute.' } }, 429)
      : htmlResponse(renderMessage({ title: 'Slow down', message: 'Too many requests from here. Try again in a minute.' }), 429);
  }
  if (write && Number(request.headers.get('content-length') ?? 0) > 16 * 1024) return json({ error: { code: 'invalid_input', message: 'Request too large.' } }, 413);

  try {
    // Awaited here: an unawaited route promise would reject past this catch
    // and surface as a Cloudflare 1101 page instead of a logged 500.
    return await dispatch(request, deps, path, write);
  } catch (err) {
    await deps.core.reportError('public_route', `${path}: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    return path.startsWith('/api/')
      ? json({ error: { code: 'internal', message: 'Something went wrong. Try again shortly.' } }, 500)
      : htmlResponse(renderMessage({ title: 'Something went wrong', message: 'It has been logged. Try again in a moment.' }), 500);
  }
}

async function dispatch(request: Request, deps: RouteDeps, path: string, write: boolean): Promise<Response> {
  if (path === '/healthz') {
    const r = await deps.core.ping();
    return json({ public: 'ok', core: r.ok ? r.value : r.error }, r.ok ? 200 : 503);
  }
  if (path === '/mcp') {
    return handleMcp(request, { name: 'wellmet-public', title: `Book time with ${deps.config.ownerName}`, version: '1.0.0', instructions: PUBLIC_INSTRUCTIONS(deps.config) },
      publicTools(deps.core, deps.config, callerOf(request, 'mcp')), { maxBodyBytes: 16 * 1024 });
  }
  if (path.startsWith('/api/')) return api(request, path, deps);
  if (path === '/') return index(deps);
  if (path === '/privacy') return htmlResponse(renderPrivacy({ ownerName: deps.config.ownerName }));

  const manage = path.match(/^\/b\/([A-Za-z0-9-]+\.[A-Za-z0-9_-]+)(\/cancel|\/reschedule)?$/);
  if (manage) {
    const [, token, action] = manage as unknown as [string, string, string | undefined];
    if (!action) return status(request, deps, token);
    if (action === '/cancel' && write) return cancel(request, deps, token);
    if (action === '/reschedule') return write ? moveDo(request, deps, token) : moveConfirm(request, deps, token);
  }
  const book = path.match(/^\/([a-z0-9][a-z0-9-]{1,39})\/book$/);
  if (book) return write ? confirmPost(request, deps, book[1]!) : confirmGet(request, deps, book[1]!);
  const type = path.match(/^\/([a-z0-9][a-z0-9-]{1,39})$/);
  if (type && !write) return bookingPage(request, deps, type[1]!);
  return htmlResponse(renderMessage({ title: 'Not found', message: 'There is nothing at this address.', linkHref: '/', linkText: 'See what can be booked' }), 404);
}

// --- Pages ----------------------------------------------------------------------------

async function index(deps: RouteDeps): Promise<Response> {
  const r = await deps.core.listEventTypes();
  if (!r.ok) return htmlResponse(renderMessage({ title: 'Try again shortly', message: r.error.message }), STATUS[r.error.code] ?? 500);
  const c = deps.config;
  return htmlResponse(renderIndex({
    host: host(c),
    eventTypes: r.value.map((t) => summary(t)),
    agent: { copyLine: indexShareLine(c) },
  }));
}

async function bookingPage(request: Request, deps: RouteDeps, slug: string): Promise<Response> {
  const url = new URL(request.url);
  const typeR = await deps.core.getEventType(slug);
  if (!typeR.ok) return htmlResponse(renderMessage({ title: 'Not found', message: 'There is no such meeting to book.', linkHref: '/', linkText: 'See what can be booked' }), 404);
  const t = typeR.value;
  const tz = visitorTz(request, t.timezone);
  const lengthParam = Number(url.searchParams.get('length'));
  const lengthMin = t.lengths.includes(lengthParam) ? lengthParam : t.lengths[0]!;
  const reschedule = url.searchParams.get('reschedule');
  let rescheduling: { from: string } | undefined;
  if (reschedule) {
    const b = await deps.core.getBooking(reschedule);
    if (!b.ok || !b.value.can_reschedule) return htmlResponse(renderMessage({ title: 'Can\'t move this booking', message: b.ok ? 'This booking can no longer be moved.' : b.error.message }), 400);
    const z = zoned(b.value.start, tz);
    rescheduling = { from: `${weekdayLong(z)} ${dayMonth(z)} at ${hhmm(z)}` };
  }

  const now = Date.now();
  const today = zoned(now, tz).toPlainDate();
  const monthParam = url.searchParams.get('month');
  let ym = today.toPlainYearMonth();
  try {
    if (monthParam) ym = Temporal.PlainYearMonth.from(monthParam);
  } catch {
    // ignore a malformed month
  }
  const lastBookable = zoned(now + t.window_days * DAY, tz).toPlainDate().toPlainYearMonth();
  if (Temporal.PlainYearMonth.compare(ym, today.toPlainYearMonth()) < 0) ym = today.toPlainYearMonth();
  if (Temporal.PlainYearMonth.compare(ym, lastBookable) > 0) ym = lastBookable;

  const [monthStart, monthEnd] = monthBounds(ym, tz);
  // The visible month, plus the next 7 days for the "all open times" list.
  const slotsR = await deps.core.findSlots(slug, new Date(Math.max(now, monthStart)).toISOString(), new Date(Math.max(monthEnd, now + 7 * DAY)).toISOString(), lengthMin);
  if (!slotsR.ok) {
    return htmlResponse(renderMessage({ title: slotsR.error.code === 'calendar_unavailable' ? 'Try again shortly' : 'Can\'t show times', message: slotsR.error.message }), STATUS[slotsR.error.code] ?? 500);
  }
  // Also include the next 7 days for the "all open times" list when the month starts later.
  let slots = slotsR.value;
  if (monthStart > now) {
    const soon = await deps.core.findSlots(slug, new Date(now).toISOString(), new Date(now + 7 * DAY).toISOString(), lengthMin);
    if (soon.ok) slots = [...soon.value, ...slots];
  }

  const keep: Record<string, string> = {};
  if (lengthMin !== t.lengths[0]) keep.length = String(lengthMin);
  if (reschedule) keep.reschedule = reschedule;
  if (url.searchParams.get('tz') && validTimeZone(url.searchParams.get('tz'))) keep.tz = tz;
  const pageHref = (extra: Record<string, string>) => `/${slug}?${new URLSearchParams({ ...keep, ...extra }).toString()}`;
  const slotHref = (s: PublicSlot) => {
    const start = isoWithOffset(zoned(s.start, tz));
    return reschedule
      ? `/b/${reschedule}/reschedule?${new URLSearchParams({ start, ...(keep.tz ? { tz } : {}) })}`
      : `/${slug}/book?${new URLSearchParams({ start, ...(keep.length ? { length: keep.length } : {}), ...(keep.tz ? { tz } : {}) })}`;
  };

  // Group by date in the visitor's timezone.
  const byDate = new Map<string, Slot[]>();
  for (const s of slots) {
    const z = zoned(s.start, tz);
    const key = z.toPlainDate().toString();
    const list = byDate.get(key) ?? [];
    if (!list.some((x) => x.start === s.start)) list.push({ start: s.start, label: hhmm(z), href: slotHref(s) });
    byDate.set(key, list);
  }
  const dayView = (date: Temporal.PlainDate): Day => ({
    weekday: weekdayLong(date),
    date: dayMonth(date),
    short: `${weekdayShort(date)} ${date.day}`,
    slots: byDate.get(date.toString()) ?? [],
  });

  // Selected date: ?date= if in this month, else the first date with times.
  const dateParam = url.searchParams.get('date');
  const monthDates: Temporal.PlainDate[] = [];
  for (let d = ym.toPlainDate({ day: 1 }); d.month === ym.month; d = d.add({ days: 1 })) monthDates.push(d);
  let selected = monthDates.find((d) => d.toString() === dateParam && Temporal.PlainDate.compare(d, today) >= 0);
  selected ??= monthDates.find((d) => (byDate.get(d.toString())?.length ?? 0) > 0);

  const dates: CalendarDate[] = monthDates.map((d) => {
    const n = byDate.get(d.toString())?.length ?? 0;
    const past = Temporal.PlainDate.compare(d, today) < 0;
    return {
      day: d.day,
      href: n > 0 && !past ? pageHref({ month: ym.toString(), date: d.toString() }) : null,
      openCount: n,
      state: past ? 'past' : selected && d.equals(selected) ? 'selected' : n > 0 ? 'open' : 'closed',
    };
  });
  const firstOfMonth = ym.toPlainDate({ day: 1 });
  const prev = ym.subtract({ months: 1 });
  const next = ym.add({ months: 1 });

  const upcoming: Day[] = [];
  for (let d = today; upcoming.length < 7 && Temporal.PlainDate.compare(d, today.add({ days: 7 })) < 0; d = d.add({ days: 1 })) {
    const v = dayView(d);
    if (v.slots.length) upcoming.push(v);
  }

  let nextOpen: { label: string; href: string } | undefined;
  if (selected && !(byDate.get(selected.toString())?.length)) {
    const later = [...byDate.keys()].sort().find((k) => k > selected!.toString());
    if (later) {
      const d = Temporal.PlainDate.from(later);
      nextOpen = { label: `${weekdayLong(d)} ${dayMonth(d)}`, href: pageHref({ month: d.toPlainYearMonth().toString(), date: later }) };
    }
  }

  return htmlResponse(renderBooking({
    host: host(deps.config),
    eventType: summary(t, lengthMin),
    month: {
      label: monthLabel(ym),
      prevHref: Temporal.PlainYearMonth.compare(prev, today.toPlainYearMonth()) >= 0 ? pageHref({ month: prev.toString() }) : null,
      prevLabel: monthShort(prev),
      nextHref: Temporal.PlainYearMonth.compare(next, lastBookable) <= 0 ? pageHref({ month: next.toString() }) : null,
      nextLabel: monthShort(next),
      leadingBlanks: firstOfMonth.dayOfWeek % 7,
      dates,
    },
    selected: selected ? dayView(selected) : null,
    upcoming,
    ...(nextOpen ? { nextOpen } : {}),
    timezone: { current: tz, options: TIMEZONE_CHOICES.includes(tz) ? TIMEZONE_CHOICES : [tz, ...TIMEZONE_CHOICES], action: `/${slug}`, hidden: { ...(keep.length ? { length: keep.length } : {}), ...(reschedule ? { reschedule } : {}) } },
    agent: { copyLine: shareLine(deps.config, t), mcpUrl: `${deps.config.publicUrl}/mcp`, slotsUrl: `${deps.config.publicUrl}/api/slots`, bookingsUrl: `${deps.config.publicUrl}/api/bookings`, slug },
    ...(rescheduling ? { rescheduling } : {}),
    ...(t.lengths.length > 1 ? { lengthChoices: t.lengths.map((m) => ({ minutes: m, current: m === lengthMin, href: `/${slug}?${new URLSearchParams({ ...(m !== t.lengths[0] ? { length: String(m) } : {}), ...(reschedule ? { reschedule } : {}), ...(keep.tz ? { tz } : {}) })}` })) } : {}),
  }));
}

function chosenFor(startIso: string, lengthMin: number, tz: string) {
  const z = zoned(startIso, tz);
  const end = z.add({ minutes: lengthMin });
  return { start: isoWithOffset(z), weekday: weekdayLong(z), date: dayMonth(z), timeLine: `${hhmm(z)} – ${hhmm(end)}` };
}

async function confirmGet(request: Request, deps: RouteDeps, slug: string, state?: { values: { name: string; email: string; answers: Record<string, string> }; errors: FieldErrors; problem?: { message: string; alternatives: Slot[] } }): Promise<Response> {
  const url = new URL(request.url);
  const typeR = await deps.core.getEventType(slug);
  if (!typeR.ok) return htmlResponse(renderMessage({ title: 'Not found', message: 'There is no such meeting to book.' }), 404);
  const t = typeR.value;
  const tz = visitorTz(request, t.timezone);
  const start = url.searchParams.get('start');
  if (!start || Number.isNaN(Date.parse(start))) return see(`/${slug}`);
  const lengthParam = Number(url.searchParams.get('length'));
  const lengthMin = t.lengths.includes(lengthParam) ? lengthParam : t.lengths[0]!;
  const backQuery = new URLSearchParams({ ...(lengthMin !== t.lengths[0] ? { length: String(lengthMin) } : {}), date: zoned(start, tz).toPlainDate().toString(), month: zoned(start, tz).toPlainDate().toPlainYearMonth().toString() });
  return htmlResponse(renderConfirm({
    host: host(deps.config),
    eventType: summary(t, lengthMin),
    chosen: chosenFor(start, lengthMin, tz),
    timezone: tz,
    questions: t.questions,
    values: state?.values ?? { name: '', email: '', answers: {} },
    errors: state?.errors ?? {},
    retryToken: crypto.randomUUID(),
    action: `/${slug}/book?${new URLSearchParams({ ...(lengthMin !== t.lengths[0] ? { length: String(lengthMin) } : {}), start })}`,
    backHref: `/${slug}?${backQuery}`,
    ...(state?.problem ? { problem: state.problem } : {}),
  }), state ? 409 : 200);
}

async function confirmPost(request: Request, deps: RouteDeps, slug: string): Promise<Response> {
  const form = await request.formData();
  const url = new URL(request.url);
  const start = String(form.get('start') ?? url.searchParams.get('start') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const answers: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith('answer_')) answers[k.slice(7)] = String(v);
  const values = { name, email, answers };

  const errors: FieldErrors = {};
  if (!name) errors.name = 'Give your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Check the email address; the invite goes there.';
  const typeR = await deps.core.getEventType(slug);
  if (typeR.ok) for (const q of typeR.value.questions) if (q.required && !answers[q.id]?.trim()) errors[q.id] = 'This needs an answer.';
  const retry = (problem?: { message: string; alternatives: Slot[] }) => {
    const r = new Request(`${url.origin}/${slug}/book?${new URLSearchParams({ start, ...(url.searchParams.get('length') ? { length: url.searchParams.get('length')! } : {}) })}`, { headers: request.headers });
    return confirmGet(r, deps, slug, { values, errors, ...(problem ? { problem } : {}) });
  };
  if (Object.keys(errors).length) return retry();

  const length = Number(url.searchParams.get('length'));
  const r = await deps.core.requestBooking({
    event_type: slug,
    start,
    ...(length ? { length_min: length } : {}),
    name,
    email,
    timezone: String(form.get('timezone') ?? 'UTC'),
    answers,
    retry_token: String(form.get('retry_token') ?? crypto.randomUUID()),
  }, callerOf(request, 'web'));
  if (r.ok) return see(`/b/${r.value.booking_token}?new=1`);
  if (r.error.code === 'slot_taken') {
    const tz = String(form.get('timezone') ?? 'UTC');
    const alternatives = ((r.error.details?.alternatives as number[] | undefined) ?? []).map((ms) => {
      const z = zoned(ms, validTimeZone(tz) ? tz : 'UTC');
      return { start: new Date(ms).toISOString(), label: `${weekdayShort(z)} ${hhmm(z)}`, href: `/${slug}/book?${new URLSearchParams({ start: isoWithOffset(z), ...(length ? { length: String(length) } : {}) })}` };
    });
    return retry({ message: r.error.message, alternatives });
  }
  return retry({ message: r.error.message, alternatives: [] });
}

function receiptFor(b: GuestBooking, tz: string): BookingReceipt {
  const z = zoned(b.start, tz);
  const end = zoned(b.end, tz);
  const status: BookingReceipt['status'] = b.status === 'accepted' ? 'confirmed' : b.status === 'failed' ? 'cancelled' : b.status;
  return {
    status,
    title: b.title,
    guestName: b.guest_name,
    weekday: weekdayLong(z),
    date: dayMonth(z),
    timeLine: `${hhmm(z)} – ${hhmm(end)}`,
    timezone: tz,
    location: b.location,
    meetUrl: b.meeting_url,
    cancelAction: b.can_cancel ? `/b/${b.id}` : null,
    rescheduleHref: b.can_reschedule ? `/b/${b.id}` : null,
    reschedulesLeft: b.reschedules_left,
    note: b.status === 'failed' ? 'This booking could not be completed, so nothing was booked. Please pick another time.' : null,
  };
}

async function status(request: Request, deps: RouteDeps, token: string): Promise<Response> {
  const r = await deps.core.getBooking(token);
  if (!r.ok) return htmlResponse(renderMessage({ title: 'Not found', message: r.error.message }), 404);
  const b = r.value;
  const tz = visitorTz(request, validTimeZone(b.guest_timezone) ? b.guest_timezone : 'UTC');
  const receipt = receiptFor(b, tz);
  receipt.cancelAction = b.can_cancel ? `/b/${token}/cancel` : null;
  receipt.rescheduleHref = b.can_reschedule ? `/${b.event_type}?${new URLSearchParams({ reschedule: token })}` : null;
  const isNew = new URL(request.url).searchParams.get('new') === '1';
  return htmlResponse(renderStatus({
    host: host(deps.config),
    receipt,
    ...(isNew ? { flash: b.status === 'pending' ? 'Request sent.' : 'Booked.' } : {}),
    bookAgainHref: `/${b.event_type}`,
  }));
}

async function cancel(request: Request, deps: RouteDeps, token: string): Promise<Response> {
  const form = await request.formData();
  const reason = String(form.get('reason') ?? '').trim();
  const r = await deps.core.cancelBooking(token, reason || undefined);
  if (!r.ok) return htmlResponse(renderMessage({ title: 'Not cancelled', message: r.error.message, linkHref: `/b/${token}`, linkText: 'Back to the booking' }), STATUS[r.error.code] ?? 400);
  return see(`/b/${token}`);
}

async function moveConfirm(request: Request, deps: RouteDeps, token: string): Promise<Response> {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const b = await deps.core.getBooking(token);
  if (!b.ok) return htmlResponse(renderMessage({ title: 'Not found', message: b.error.message }), 404);
  if (!start || Number.isNaN(Date.parse(start))) return see(`/${b.value.event_type}?reschedule=${token}`);
  const tz = visitorTz(request, validTimeZone(b.value.guest_timezone) ? b.value.guest_timezone : 'UTC');
  const lengthMin = Math.round((Date.parse(b.value.end) - Date.parse(b.value.start)) / 60_000);
  return htmlResponse(renderMoveConfirm({
    host: host(deps.config),
    title: b.value.title,
    chosen: chosenFor(start, lengthMin, tz),
    timezone: tz,
    action: `/b/${token}/reschedule`,
    backHref: `/${b.value.event_type}?reschedule=${token}`,
  }));
}

async function moveDo(request: Request, deps: RouteDeps, token: string): Promise<Response> {
  const form = await request.formData();
  const r = await deps.core.rescheduleBooking(token, String(form.get('start') ?? ''));
  if (!r.ok) return htmlResponse(renderMessage({ title: 'Not moved', message: r.error.message, linkHref: `/b/${token}`, linkText: 'Back to the booking' }), STATUS[r.error.code] ?? 400);
  return see(`/b/${token}`);
}

// --- JSON API ----------------------------------------------------------------------------

async function api(request: Request, path: string, deps: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const write = request.method === 'POST';
  if (path === '/api/event-types' && !write) {
    const r = await deps.core.listEventTypes();
    return r.ok ? json({ event_types: r.value.map((t) => ({ ...t, page_url: `${deps.config.publicUrl}/${t.slug}` })) }) : apiError(r);
  }
  if (path === '/api/slots' && !write) {
    const slug = url.searchParams.get('type') ?? url.searchParams.get('event_type') ?? '';
    const now = Date.now();
    const from = url.searchParams.get('from') ?? new Date(now).toISOString();
    const to = url.searchParams.get('to') ?? new Date(Date.parse(from) + 7 * DAY).toISOString();
    const tz = url.searchParams.get('tz');
    const length = Number(url.searchParams.get('length') ?? url.searchParams.get('length_min'));
    const r = await deps.core.findSlots(slug, from, to, length || undefined);
    if (!r.ok) return apiError(r);
    return json({
      event_type: slug,
      timezone: validTimeZone(tz) ? tz : 'UTC',
      slots: r.value.map((s) => ({ ...s, ...(validTimeZone(tz) ? { local: isoWithOffset(zoned(s.start, tz)) } : {}) })),
    });
  }
  if (path === '/api/bookings' && write) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: { code: 'invalid_input', message: 'Send a JSON body.' } }, 400);
    }
    const r = await deps.core.requestBooking(body, callerOf(request, 'api'));
    return r.ok ? json(r.value, r.value.outcome === 'pending' ? 202 : 201) : apiError(r);
  }
  const one = path.match(/^\/api\/bookings\/([A-Za-z0-9-]+\.[A-Za-z0-9_-]+)(\/cancel|\/reschedule)?$/);
  if (one) {
    const [, token, action] = one as unknown as [string, string, string | undefined];
    if (!action && !write) {
      const r = await deps.core.getBooking(token);
      return r.ok ? json(r.value) : apiError(r);
    }
    if (action === '/cancel' && write) {
      const body = (await request.json().catch(() => ({}))) as { reason?: string };
      const r = await deps.core.cancelBooking(token, body.reason);
      return r.ok ? json(r.value) : apiError(r);
    }
    if (action === '/reschedule' && write) {
      const body = (await request.json().catch(() => ({}))) as { start?: string };
      const r = await deps.core.rescheduleBooking(token, String(body.start ?? ''));
      return r.ok ? json(r.value) : apiError(r);
    }
  }
  return json({ error: { code: 'not_found', message: 'No such API route. See GET /api/event-types, GET /api/slots, POST /api/bookings.' } }, 404);
}

