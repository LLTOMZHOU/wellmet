import { html, type SafeHtml } from './html.ts';
import { page, seal } from './layout.ts';
import type {
  AgentInfo,
  BookingReceipt,
  ChosenSlot,
  EventTypeSummary,
  FieldErrors,
  FieldValues,
  Host,
  Question,
  Slot,
  Timezone,
  Week,
} from './types.ts';

// ---------------------------------------------------------------------------
// Shared pieces

function modeLabel(mode: EventTypeSummary['mode']): string {
  return mode === 'instant' ? 'Confirms instantly' : 'Confirmed by request';
}

function facts(eventType: EventTypeSummary, timezone?: Timezone): SafeHtml {
  return html`<dl class="facts">
    <div><dt>Length</dt><dd>${eventType.durationMin} min</dd></div>
    <div><dt>Where</dt><dd>${eventType.location}</dd></div>
    <div><dt>Booking</dt><dd>${modeLabel(eventType.mode)}</dd></div>
    ${timezone ? html`<div><dt>Times in</dt><dd>${timezoneSwitcher(timezone)}</dd></div>` : ''}
  </dl>`;
}

function timezoneSwitcher(tz: Timezone): SafeHtml {
  return html`<details class="tz">
    <summary><span class="tz__name">${tz.current.replaceAll('_', ' ')}</span> <span class="tz__change">change</span></summary>
    <form class="tz__form" method="get" action="${tz.action}">
      ${Object.entries(tz.hidden).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}
      <label class="visually-hidden" for="tz-select">Timezone</label>
      <select id="tz-select" name="tz">
        ${tz.options.map((option) => html`<option value="${option}"${option === tz.current ? html` selected` : ''}>${option.replaceAll('_', ' ')}</option>`)}
      </select>
      <button class="button button--quiet" type="submit">Show times</button>
    </form>
  </details>`;
}

function callingCard(host: Host, eventType: EventTypeSummary, timezone?: Timezone, extra?: SafeHtml): SafeHtml {
  return html`<section class="card" aria-labelledby="event-title">
    <div class="card__head">
      <p class="eyebrow">Meeting with</p>
      ${seal({ waves: true, className: 'seal seal--card' })}
    </div>
    <p class="card__host">${host.name}</p>
    ${host.tagline ? html`<p class="card__tagline">${host.tagline}</p>` : ''}
    <h1 class="card__title" id="event-title">${eventType.title}</h1>
    ${eventType.description ? html`<p class="card__desc">${eventType.description}</p>` : ''}
    ${facts(eventType, timezone)}
    ${extra ?? ''}
  </section>`;
}

function agentNote(agent: AgentInfo): SafeHtml {
  return html`<aside class="note" aria-labelledby="note-title">
    <h2 class="note__title" id="note-title">For AI assistants</h2>
    <p class="note__lead">Prefer to let your assistant find a time? Paste this line into it:</p>
    <div class="copy">
      <code class="copy__text" id="copy-line">${agent.copyLine}</code>
      <button class="copy__button" type="button" data-copy="copy-line" hidden>Copy</button>
    </div>
    <details class="note__more">
      <summary>Instructions an assistant can follow</summary>
      <p>No login or key is needed. The open times are listed as links on this page.</p>
      <ul class="endpoints">
        <li><span>MCP</span><code>${agent.mcpUrl}</code></li>
        <li><span>Times</span><code>GET ${agent.slotsUrl}?type=${agent.slug}&amp;tz=…</code></li>
        <li><span>Book</span><code>POST ${agent.bookingsUrl}</code></li>
      </ul>
      <p>Send <code>event_type</code>, <code>start</code>, <code>name</code>, <code>email</code>, <code>timezone</code> and a random <code>retry_token</code>. If unsure whether a request went through, send it again with the same <code>retry_token</code>; it will not book twice.</p>
      <p>An assistant that can only read pages can hand the visitor a link to one of the times below; the visitor then confirms with one press.</p>
    </details>
  </aside>`;
}

function slotLink(slot: Slot): SafeHtml {
  return html`<li><a class="ticket" href="${slot.href}" data-start="${slot.start}">${slot.label}</a></li>`;
}

// ---------------------------------------------------------------------------
// 1. Event-type list

export function renderIndex(input: { host: Host; eventTypes: EventTypeSummary[] }): string {
  const body = html`<div class="frame frame--narrow">
    <section class="intro">
      ${seal({ waves: true, className: 'seal seal--card' })}
      <p class="eyebrow">Book time with</p>
      <h1 class="intro__name">${input.host.name}</h1>
      ${input.host.tagline ? html`<p class="card__tagline">${input.host.tagline}</p>` : ''}
    </section>
    ${input.eventTypes.length === 0
      ? html`<p class="empty">There's nothing to book right now. Check back later.</p>`
      : html`<ul class="types" aria-label="Meetings you can book">
        ${input.eventTypes.map((t) => html`<li>
          <a class="type" href="${t.href}">
            <span class="type__title">${t.title}</span>
            <span class="type__meta">${t.durationMin} min · ${t.location} · ${t.mode === 'instant' ? 'Instant' : 'On request'}</span>
            ${t.description ? html`<span class="type__desc">${t.description}</span>` : ''}
            <span class="type__go" aria-hidden="true">→</span>
          </a>
        </li>`)}
      </ul>`}
  </div>`;
  return page({ title: `Book time with ${input.host.name}`, host: input.host }, body).toString();
}

// ---------------------------------------------------------------------------
// 2. Booking page: pick a time

export function renderBooking(input: {
  host: Host;
  eventType: EventTypeSummary;
  week: Week;
  timezone: Timezone;
  agent: AgentInfo;
  /** Set when the guest is choosing a new time for an existing booking. */
  rescheduling?: { from: string };
}): string {
  const { week } = input;
  const nav = html`<nav class="weeknav" aria-label="Weeks">
    ${week.prevHref ? html`<a href="${week.prevHref}" rel="prev">← Earlier</a>` : html`<span aria-hidden="true"></span>`}
    <span class="weeknav__label">${week.label}</span>
    ${week.nextHref ? html`<a href="${week.nextHref}" rel="next">Later →</a>` : html`<span aria-hidden="true"></span>`}
  </nav>`;

  const ledger = week.days.length === 0
    ? html`<div class="empty">
        <p>No open times this week.</p>
        ${week.nextHref ? html`<p><a href="${week.nextHref}">See the next week →</a></p>` : ''}
      </div>`
    : html`<ol class="ledger">
        ${week.days.map((day) => html`<li class="day">
          <h3 class="day__label"><span class="day__weekday">${day.weekday}</span><span class="day__date">${day.monthDay}</span></h3>
          <ul class="tickets" aria-label="${day.weekday} ${day.monthDay}">${day.slots.map(slotLink)}</ul>
        </li>`)}
      </ol>`;

  const body = html`<div class="frame">
    <div class="side">
      ${callingCard(input.host, input.eventType, input.timezone)}
      ${input.rescheduling ? '' : agentNote(input.agent)}
    </div>
    <section class="pick" aria-labelledby="pick-title">
      ${input.rescheduling
        ? html`<p class="banner">Choosing a new time for your booking on ${input.rescheduling.from}. Your current time stays booked until you confirm the new one.</p>`
        : ''}
      <div class="pick__head">
        <h2 class="pick__title" id="pick-title">${input.rescheduling ? 'Pick a new time' : 'Choose a time'}</h2>
        ${nav}
      </div>
      ${ledger}
    </section>
  </div>`;

  return page(
    { title: `${input.eventType.title} with ${input.host.name}`, host: input.host, withScript: true },
    body,
  ).toString();
}

// ---------------------------------------------------------------------------
// 3. Confirm form

export function renderConfirm(input: {
  host: Host;
  eventType: EventTypeSummary;
  chosen: ChosenSlot;
  timezone: string;
  questions: Question[];
  values: FieldValues;
  errors: FieldErrors;
  retryToken: string;
  action: string;
  backHref: string;
  /** "That time was just taken", with nearby times. */
  problem?: { message: string; alternatives: Slot[] };
}): string {
  const err = (key: string) => input.errors[key];
  const field = (id: string, label: string, control: SafeHtml, hint?: string) => html`<div class="field${err(id) ? ' field--error' : ''}">
    <label for="f-${id}">${label}</label>
    ${control}
    ${err(id) ? html`<p class="field__error" id="e-${id}">${err(id)}</p>` : hint ? html`<p class="field__hint">${hint}</p>` : ''}
  </div>`;
  const describedBy = (id: string) => (err(id) ? html` aria-describedby="e-${id}" aria-invalid="true"` : '');

  const stamp = html`<div class="chosen${input.problem ? ' chosen--taken' : ''}">
    <p class="eyebrow">${input.problem ? 'No longer open' : 'Your time'}</p>
    <p class="chosen__ticket"><span class="chosen__date">${input.chosen.dateLine}</span><span class="chosen__time">${input.chosen.timeLine}</span></p>
    <p class="chosen__tz">${input.timezone.replaceAll('_', ' ')}</p>
    <a class="chosen__back" href="${input.backHref}">← Choose another time</a>
  </div>`;

  const body = html`<div class="frame frame--confirm">
    <div class="side">${callingCard(input.host, input.eventType, undefined, stamp)}</div>
    <section class="pick" aria-labelledby="form-title">
      ${input.problem
        ? html`<div class="banner banner--warn" role="alert">
            <p>${input.problem.message}</p>
            ${input.problem.alternatives.length
              ? html`<ul class="tickets tickets--inline" aria-label="Nearby times">${input.problem.alternatives.map(slotLink)}</ul>`
              : ''}
          </div>`
        : ''}
      <h2 class="pick__title" id="form-title">Your details</h2>
      <form class="form" method="post" action="${input.action}" novalidate>
        <input type="hidden" name="start" value="${input.chosen.start}">
        <input type="hidden" name="timezone" value="${input.timezone}">
        <input type="hidden" name="retry_token" value="${input.retryToken}">
        ${field('name', 'Your name', html`<input id="f-name" name="name" type="text" autocomplete="name" maxlength="100" required value="${input.values.name}"${describedBy('name')}>`)}
        ${field('email', 'Email', html`<input id="f-email" name="email" type="email" autocomplete="email" maxlength="254" required value="${input.values.email}"${describedBy('email')}>`, 'The calendar invite goes here.')}
        ${input.questions.map((q) => {
          const value = input.values.answers[q.id] ?? '';
          const name = `answer_${q.id}`;
          const control = q.multiline
            ? html`<textarea id="f-${q.id}" name="${name}" rows="4" maxlength="500"${q.required ? html` required` : ''}${describedBy(q.id)}>${value}</textarea>`
            : html`<input id="f-${q.id}" name="${name}" type="text" maxlength="500" value="${value}"${q.required ? html` required` : ''}${describedBy(q.id)}>`;
          return field(q.id, q.required ? q.label : `${q.label} (optional)`, control);
        })}
        <div class="form__actions">
          <button class="button button--stamp" type="submit">${input.eventType.mode === 'instant' ? 'Confirm booking' : 'Send request'}</button>
          <p class="form__fine">${input.eventType.mode === 'instant'
            ? `You'll get a calendar invite from ${input.host.name} with the meeting link.`
            : `${input.host.name} confirms each request. You'll get a calendar invite once it's accepted.`}</p>
        </div>
      </form>
    </section>
  </div>`;

  return page({ title: `Confirm: ${input.eventType.title}`, host: input.host }, body).toString();
}

// ---------------------------------------------------------------------------
// 4. Booking status and manage page

const STATUS_WORD: Record<BookingReceipt['status'], string> = {
  pending: 'Requested',
  confirmed: 'Booked',
  declined: 'Declined',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const STATUS_LEAD: Record<BookingReceipt['status'], (host: string) => string> = {
  pending: (h) => `Your request is with ${h}. You'll get a calendar invite once it's accepted.`,
  confirmed: () => `You're booked. A calendar invite is on its way to your inbox.`,
  declined: (h) => `${h} couldn't make this time. You're welcome to pick another.`,
  expired: () => `This request wasn't answered in time, so it has lapsed. You're welcome to pick another time.`,
  cancelled: () => `This booking is cancelled.`,
};

export function renderStatus(input: { host: Host; receipt: BookingReceipt; flash?: string; bookAgainHref: string }): string {
  const r = input.receipt;
  const live = r.status === 'pending' || r.status === 'confirmed';
  const body = html`<div class="frame frame--narrow">
    ${input.flash ? html`<p class="banner" role="status">${input.flash}</p>` : ''}
    <article class="receipt receipt--${r.status}" aria-labelledby="receipt-title">
      <div class="receipt__mark" aria-hidden="true">
        <span class="postmark"><span>${STATUS_WORD[r.status]}</span></span>
      </div>
      <p class="eyebrow visually-hidden">${STATUS_WORD[r.status]}</p>
      <h1 class="receipt__title" id="receipt-title">${r.title}</h1>
      <p class="receipt__lead">${STATUS_LEAD[r.status](input.host.name)}</p>
      <dl class="facts facts--receipt">
        <div><dt>When</dt><dd>${r.dateLine}<br><span class="mono">${r.timeLine}</span></dd></div>
        <div><dt>Times in</dt><dd>${r.timezone.replaceAll('_', ' ')}</dd></div>
        <div><dt>With</dt><dd>${input.host.name} and ${r.guestName}</dd></div>
        <div><dt>Where</dt><dd>${r.status === 'confirmed' && r.meetUrl
          ? html`<a href="${r.meetUrl}">${r.location}</a>`
          : r.status === 'confirmed'
            ? html`${r.location}<br><span class="muted">The link will be added to your invite shortly.</span>`
            : r.location}</dd></div>
      </dl>
      ${r.note ? html`<p class="receipt__note">${r.note}</p>` : ''}
      ${r.status === 'confirmed' && r.meetUrl ? html`<a class="button button--stamp" href="${r.meetUrl}">Join the meeting</a>` : ''}
      ${!live ? html`<a class="button button--quiet" href="${input.bookAgainHref}">Pick another time</a>` : ''}
    </article>
    ${live && (r.rescheduleHref || r.cancelAction)
      ? html`<section class="manage" aria-labelledby="manage-title">
          <h2 class="manage__title" id="manage-title">Need to change it?</h2>
          <div class="manage__actions">
            ${r.rescheduleHref && r.reschedulesLeft > 0
              ? html`<a class="button button--quiet" href="${r.rescheduleHref}">Choose a new time</a>`
              : ''}
            ${r.cancelAction
              ? html`<details class="confirm-cancel">
                  <summary class="button button--quiet">Cancel ${r.status === 'pending' ? 'request' : 'booking'}</summary>
                  <form method="post" action="${r.cancelAction}">
                    <label for="f-reason">Reason (optional, shared with ${input.host.name})</label>
                    <textarea id="f-reason" name="reason" rows="2" maxlength="300"></textarea>
                    <button class="button button--danger" type="submit">Yes, cancel it</button>
                  </form>
                </details>`
              : ''}
          </div>
          ${r.rescheduleHref && r.reschedulesLeft === 0 ? html`<p class="field__hint">This booking has been moved as many times as allowed. You can still cancel it.</p>` : ''}
          <p class="field__hint">Keep this page's link: it's the only way to change your booking.</p>
        </section>`
      : ''}
  </div>`;
  return page({ title: `${STATUS_WORD[r.status]}: ${r.title}`, host: input.host }, body).toString();
}
