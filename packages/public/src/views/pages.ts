import { html, type SafeHtml } from '@wellmet/contracts/html';
import { page, sheet, topRow } from './layout.ts';
import type {
  AgentInfo,
  BookingReceipt,
  ChosenSlot,
  Day,
  EventTypeSummary,
  FieldErrors,
  FieldValues,
  Host,
  Month,
  Question,
  Slot,
  Timezone,
} from './types.ts';

// ---------------------------------------------------------------------------
// Shared pieces

const pretty = (tz: string) => tz.replaceAll('_', ' ');

function headline(title: string, host: Host): SafeHtml {
  return html`<h1 class="headline">${title}<span class="headline__second">with ${host.name}</span></h1>`;
}

function facts(eventType: EventTypeSummary, host: Host): SafeHtml {
  const booking = eventType.mode === 'instant' ? 'Confirms instantly' : `${host.name.split(' ')[0]} confirms`;
  return html`<dl class="facts">
    <div><dt>Length</dt><dd>${eventType.durationMin} min</dd></div>
    <div><dt>Where</dt><dd>${eventType.location}</dd></div>
    <div><dt>Booking</dt><dd>${booking}</dd></div>
  </dl>`;
}

function timezoneSwitcher(tz: Timezone): SafeHtml {
  return html`<details class="tz">
    <summary>Times in ${pretty(tz.current)} <span class="tz__change">change</span></summary>
    <form class="tz__form" method="get" action="${tz.action}">
      ${Object.entries(tz.hidden).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}
      <label class="visually-hidden" for="tz-select">Timezone</label>
      <select id="tz-select" name="tz">
        ${tz.options.map((option) => html`<option value="${option}"${option === tz.current ? html` selected` : ''}>${pretty(option)}</option>`)}
      </select>
      <button class="button button--small" type="submit">Show times</button>
    </form>
  </details>`;
}

function calendar(month: Month): SafeHtml {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Weeks that are entirely in the past get a class so narrow screens can drop them.
  const rowOf = (i: number) => Math.floor((month.leadingBlanks + i) / 7);
  const pastRows = new Set<number>();
  for (let row = 0; row <= rowOf(month.dates.length - 1); row++) {
    const inRow = month.dates.filter((_, i) => rowOf(i) === row);
    if (inRow.length && inRow.every((d) => d.state === 'past')) pastRows.add(row);
  }
  const weekClass = (i: number) => (pastRows.has(rowOf(i)) ? ' cal__cell--pastweek' : '');
  const blanks = Array.from({ length: month.leadingBlanks }, () => html`<span class="cal__cell cal__cell--blank${pastRows.has(0) ? ' cal__cell--pastweek' : ''}" aria-hidden="true"></span>`);
  const cells = month.dates.map((d, i) => {
    const bar = d.openCount > 0 && d.state !== 'past'
      ? html`<span class="cal__bar" style="--n:${Math.min(d.openCount, 8)}" aria-hidden="true"></span>`
      : '';
    const label = d.openCount > 0 ? `${d.day}, ${d.openCount} open` : `${d.day}, nothing open`;
    if (d.href && d.state !== 'past') {
      return html`<a class="cal__cell cal__cell--${d.state}${weekClass(i)}" href="${d.href}" data-date="${d.date}" aria-label="${label}"${d.state === 'selected' ? html` aria-current="date"` : ''}>${d.day}${bar}</a>`;
    }
    return html`<span class="cal__cell cal__cell--${d.state}${weekClass(i)}" aria-label="${label}">${d.day}${bar}</span>`;
  });
  return html`<section class="month" aria-labelledby="month-title">
    <div class="month__head">
      <h2 class="month__title" id="month-title">${month.label}</h2>
      <nav class="month__nav" aria-label="Months">
        ${month.prevHref ? html`<a href="${month.prevHref}" rel="prev">‹ ${month.prevLabel}</a>` : ''}
        ${month.nextHref ? html`<a href="${month.nextHref}" rel="next">${month.nextLabel} ›</a>` : ''}
      </nav>
    </div>
    <div class="cal" role="group" aria-label="${month.label}">
      ${weekdays.map((w) => html`<span class="cal__wd" aria-hidden="true">${w}</span>`)}
      ${blanks}${cells}
    </div>
  </section>`;
}

function timeLink(slot: Slot, extraClass = ''): SafeHtml {
  return html`<li><a class="time${extraClass}" href="${slot.href}" data-start="${slot.start}"><span class="time__label">${slot.label}</span><span class="time__go">Book</span></a></li>`;
}

function agentNote(agent: AgentInfo): SafeHtml {
  return html`<aside class="agent" aria-labelledby="agent-title">
    <h2 class="agent__title" id="agent-title">For AI assistants</h2>
    <p>Let your assistant find a time: paste this line into it.</p>
    <div class="copy">
      <code class="copy__text" id="copy-line">${agent.copyLine}</code>
      <button class="button button--small" type="button" data-copy="copy-line" hidden>Copy</button>
    </div>
    <details class="agent__more">
      <summary>Instructions an assistant can follow</summary>
      <p>No login or key is needed. Every open time is listed as a link on this page.</p>
      <ul class="endpoints">
        <li><span>MCP</span><code>${agent.mcpUrl}</code></li>
        <li><span>Times</span><code>GET ${agent.slotsUrl}?type=${agent.slug}&amp;tz=…</code></li>
        <li><span>Book</span><code>POST ${agent.bookingsUrl}</code></li>
      </ul>
      <p>Send <code>event_type</code>, <code>start</code>, <code>name</code>, <code>email</code>, <code>timezone</code> and a random <code>retry_token</code>. If unsure whether a request went through, send it again with the same <code>retry_token</code>; it will not book twice.</p>
      <p>An assistant that can only read pages can hand the visitor a link to one of the times; the visitor then confirms with one press.</p>
    </details>
  </aside>`;
}

// ---------------------------------------------------------------------------
// 1. Event-type list

export function renderIndex(input: { host: Host; eventTypes: EventTypeSummary[]; agent: { copyLine: string } }): string {
  const count = input.eventTypes.length;
  // Left: a poster. Who at the top; how it works and the small print at the foot.
  const left = html`<div class="poster__top">
      ${topRow()}
      <h1 class="headline headline--index"><span class="headline__second">Book time with</span>${input.host.name}</h1>
      <p class="lede">Choose a kind of meeting, then a time that suits you. No account needed.</p>
    </div>
    <div class="poster__foot">
      <ol class="steps" aria-label="How it works">
        <li><span class="steps__n">01</span>Choose a meeting</li>
        <li><span class="steps__n">02</span>Pick a time, shown in your time zone</li>
        <li><span class="steps__n">03</span>Get a calendar invite with the meeting link</li>
      </ol>
      <p class="colophon"><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="https://github.com/LLTOMZHOU/wellmet">Wellmet is open source</a></p>
    </div>`;
  // Right: the meetings at the top; the assistant route anchored at the foot.
  const right = count === 0
    ? html`<div class="poster__top"><h2 class="eyebrow">Meetings</h2><p class="empty">There's nothing to book right now. Check back later.</p></div>`
    : html`<div class="poster__top">
        <h2 class="eyebrow eyebrow--count">Meetings<span>${String(count).padStart(2, '0')}</span></h2>
        <ol class="types">
          ${input.eventTypes.map((t, i) => html`<li>
            <a class="type" href="${t.href}">
              <span class="type__num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
              <span class="type__title">${t.title}</span>
              <span class="type__meta">${t.durationMin} min · ${t.location} · ${t.mode === 'instant' ? 'Instant' : 'On request'}</span>
              ${t.description ? html`<span class="type__desc">${t.description}</span>` : ''}
              <span class="type__go" aria-hidden="true">→</span>
            </a>
          </li>`)}
        </ol>
      </div>
      <aside class="agent agent--foot" aria-labelledby="agent-title">
        <h2 class="agent__title" id="agent-title">Or ask your assistant</h2>
        <p>Paste this into Claude, ChatGPT or any assistant that can read web pages. It can find a time and book for you.</p>
        <div class="copy">
          <code class="copy__text" id="copy-line">${input.agent.copyLine}</code>
          <button class="button button--small" type="button" data-copy="copy-line" hidden>Copy</button>
        </div>
      </aside>`;
  return page({ title: `Book time with ${input.host.name}`, withScript: count > 0 }, sheet(left, right, { tone: 'poster' })).toString();
}

// ---------------------------------------------------------------------------
// 2. Booking page: pick a date, then a time

export function renderBooking(input: {
  host: Host;
  eventType: EventTypeSummary;
  month: Month;
  /** The chosen date and its times; null when the month has nothing open. */
  selected: Day | null;
  /** Every other open date this month, keyed "2026-11-19". Rendered hidden so a date click needs no request. */
  otherDays?: { key: string; view: Day }[];
  /** Key of the selected date, matching `otherDays` keys. */
  selectedKey?: string;
  /** Every open time in the next days, as plain links (for agents and scanning). */
  upcoming: Day[];
  /** Shown when the selected date has nothing open. */
  nextOpen?: { label: string; href: string };
  timezone: Timezone;
  agent: AgentInfo;
  /** Set when the guest is choosing a new time for an existing booking. */
  rescheduling?: { from: string };
  /** For types offering several lengths: one link per length. */
  lengthChoices?: { minutes: number; href: string; current: boolean }[];
}): string {
  const lengths = input.lengthChoices && input.lengthChoices.length > 1
    ? html`<nav class="lengths" aria-label="Meeting length">${input.lengthChoices.map((c) => c.current
        ? html`<span class="lengths__item lengths__item--current" aria-current="true">${c.minutes} min</span>`
        : html`<a class="lengths__item" href="${c.href}">${c.minutes} min</a>`)}</nav>`
    : '';
  const left = html`${topRow(timezoneSwitcher(input.timezone))}
    ${input.rescheduling ? html`<p class="notice">New time for your booking on ${input.rescheduling.from}. Your current time stays booked until you confirm.</p>` : ''}
    ${headline(input.eventType.title, input.host)}
    ${facts(input.eventType, input.host)}
    ${lengths}
    ${input.eventType.description ? html`<p class="lede">${input.eventType.description}</p>` : ''}
    ${calendar(input.month)}`;

  const day = input.selected;
  const openDay = (key: string, view: Day, hidden: boolean) => html`<section class="day" data-day="${key}" aria-labelledby="day-title-${key}"${hidden ? html` hidden` : ''}>
        <p class="eyebrow">${view.weekday}</p>
        <h2 class="day__title" id="day-title-${key}" tabindex="-1">${view.date}</h2>
        <ul class="times">${view.slots.map((s) => timeLink(s))}</ul>
      </section>`;
  const others = (input.otherDays ?? []).filter((d) => d.key !== input.selectedKey).map((d) => openDay(d.key, d.view, true));
  const dayBlock = day && day.slots.length
    ? html`${openDay(input.selectedKey ?? 'selected', day, false)}${others}`
    : html`${others}<section class="day" data-day="${input.selectedKey ?? 'none'}" aria-labelledby="day-title">
        <p class="eyebrow">${day ? day.weekday : input.month.label}</p>
        <h2 class="day__title" id="day-title">${day ? day.date : 'Nothing open'}</h2>
        <p class="empty">Nothing is open ${day ? 'on this date' : 'this month'}.${input.nextOpen ? html` <a href="${input.nextOpen.href}">Next open: ${input.nextOpen.label} →</a>` : ''}</p>
      </section>`;

  const upcoming = input.upcoming.length
    ? html`<section class="upcoming" aria-labelledby="upcoming-title">
        <h2 class="eyebrow" id="upcoming-title">All open times, next 7 days</h2>
        <ol class="upcoming__list">
          ${input.upcoming.map((d) => html`<li class="upcoming__day">
            <span class="upcoming__date">${d.short}</span>
            <ul class="upcoming__times">${d.slots.map((s) => html`<li><a href="${s.href}" data-start="${s.start}">${s.label}</a></li>`)}</ul>
          </li>`)}
        </ol>
      </section>`
    : '';

  const right = html`${dayBlock}${upcoming}${input.rescheduling ? '' : agentNote(input.agent)}`;

  return page(
    { title: `${input.eventType.title} with ${input.host.name}`, withScript: true, withDays: true },
    sheet(left, right),
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
  const describedBy = (id: string) => (err(id) ? html` aria-describedby="e-${id}" aria-invalid="true"` : '');
  const field = (id: string, label: string, control: SafeHtml, hint?: string) => html`<div class="field${err(id) ? ' field--error' : ''}">
    <label for="f-${id}">${label}</label>
    ${control}
    ${err(id) ? html`<p class="field__error" id="e-${id}">${err(id)}</p>` : hint ? html`<p class="field__hint">${hint}</p>` : ''}
  </div>`;

  const left = html`${topRow()}
    ${headline(input.eventType.title, input.host)}
    ${facts(input.eventType, input.host)}
    <div class="chosen${input.problem ? ' chosen--taken' : ''}">
      <p class="eyebrow">${input.problem ? 'No longer open' : 'Your time'}</p>
      <p class="chosen__block">
        <span class="chosen__date">${input.chosen.weekday}, ${input.chosen.date}</span>
        <span class="chosen__time">${input.chosen.timeLine}</span>
      </p>
      <p class="chosen__tz">Times in ${pretty(input.timezone)}</p>
      <a class="backlink" href="${input.backHref}">‹ Choose another time</a>
    </div>`;

  const right = html`${input.problem
      ? html`<div class="alert" role="alert">
          <p>${input.problem.message}</p>
          ${input.problem.alternatives.length ? html`<ul class="times times--compact">${input.problem.alternatives.map((s) => timeLink(s))}</ul>` : ''}
        </div>`
      : ''}
    <h2 class="section-title">Your details</h2>
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
        <button class="button" type="submit">${input.eventType.mode === 'instant' ? 'Confirm booking' : 'Send request'}</button>
        <p class="form__fine">${input.eventType.mode === 'instant'
          ? `You'll get a calendar invite from ${input.host.name} with the meeting link.`
          : `${input.host.name} confirms each request. The calendar invite comes once it's accepted.`}</p>
      </div>
    </form>`;

  return page({ title: `Confirm: ${input.eventType.title}` }, sheet(left, right)).toString();
}

// ---------------------------------------------------------------------------
// 4. Booking status and manage page

const STATUS_WORD: Record<BookingReceipt['status'], string> = {
  pending: 'Requested.',
  confirmed: 'Booked.',
  declined: 'Declined.',
  expired: 'Lapsed.',
  cancelled: 'Cancelled.',
};

const STATUS_LEAD: Record<BookingReceipt['status'], (host: string) => string> = {
  pending: (h) => `Your request is with ${h}. You'll get a calendar invite once it's accepted.`,
  confirmed: () => `A calendar invite is on its way to your inbox.`,
  declined: (h) => `${h} couldn't make this time. You're welcome to pick another.`,
  expired: () => `This request wasn't answered in time. You're welcome to pick another time.`,
  cancelled: () => `This booking is cancelled.`,
};

export function renderStatus(input: { host: Host; receipt: BookingReceipt; flash?: string; bookAgainHref: string }): string {
  const r = input.receipt;
  const live = r.status === 'pending' || r.status === 'confirmed';

  const left = html`${topRow()}
    ${input.flash ? html`<p class="notice" role="status">${input.flash}</p>` : ''}
    <h1 class="status status--${r.status}">${STATUS_WORD[r.status]}</h1>
    <p class="lede">${STATUS_LEAD[r.status](input.host.name)}</p>
    ${r.status === 'confirmed' && r.meetUrl ? html`<p><a class="button button--signal" href="${r.meetUrl}">Join the meeting</a></p>` : ''}
    ${!live ? html`<p><a class="button button--quiet" href="${input.bookAgainHref}">Pick another time</a></p>` : ''}`;

  const right = html`<p class="eyebrow">${r.weekday}</p>
    <h2 class="day__title">${r.date}</h2>
    <dl class="rows">
      <div><dt>Time</dt><dd class="num">${r.timeLine}</dd></div>
      <div><dt>Times in</dt><dd>${pretty(r.timezone)}</dd></div>
      <div><dt>Meeting</dt><dd>${r.title}</dd></div>
      <div><dt>With</dt><dd>${input.host.name} and ${r.guestName}</dd></div>
      <div><dt>Where</dt><dd>${r.status === 'confirmed' && r.meetUrl
        ? html`<a href="${r.meetUrl}">${r.location}</a>`
        : r.status === 'confirmed'
          ? html`${r.location} <span class="muted">· link coming to your invite</span>`
          : r.location}</dd></div>
    </dl>
    ${r.note ? html`<p class="muted">${r.note}</p>` : ''}
    ${live && (r.rescheduleHref || r.cancelAction)
      ? html`<section class="manage" aria-labelledby="manage-title">
          <h2 class="eyebrow" id="manage-title">Need to change it?</h2>
          <div class="manage__actions">
            ${r.rescheduleHref && r.reschedulesLeft > 0 ? html`<a class="button button--quiet" href="${r.rescheduleHref}">Choose a new time</a>` : ''}
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
      : ''}`;

  return page({ title: `${STATUS_WORD[r.status].replace('.', '')}: ${r.title}` }, sheet(left, right)).toString();
}

// ---------------------------------------------------------------------------
// 5. Confirm moving an existing booking (a link alone never changes anything)

export function renderMoveConfirm(input: { host: Host; title: string; chosen: ChosenSlot; timezone: string; action: string; backHref: string }): string {
  const left = html`${topRow()}
    ${headline(input.title, input.host)}
    <div class="chosen">
      <p class="eyebrow">New time</p>
      <p class="chosen__block"><span class="chosen__date">${input.chosen.weekday}, ${input.chosen.date}</span><span class="chosen__time">${input.chosen.timeLine}</span></p>
      <p class="chosen__tz">Times in ${pretty(input.timezone)}</p>
      <a class="backlink" href="${input.backHref}">‹ Choose another time</a>
    </div>`;
  const right = html`<h2 class="section-title">Move your booking?</h2>
    <p class="lede">${input.host.name} gets the update, and you'll get a new invite.</p>
    <form class="form" method="post" action="${input.action}">
      <input type="hidden" name="start" value="${input.chosen.start}">
      <div class="form__actions"><button class="button" type="submit">Move booking</button></div>
    </form>`;
  return page({ title: `Move: ${input.title}` }, sheet(left, right)).toString();
}

// ---------------------------------------------------------------------------
// 6. Privacy (linked from Google's consent screen)

export function renderPrivacy(input: { ownerName: string }): string {
  const left = html`${topRow()}<h1 class="headline">Privacy</h1>
    <p class="lede">Wellmet is ${input.ownerName}'s own booking page. It is not a service anyone else signs up for.</p>`;
  const right = html`<h2 class="section-title">What a booking keeps</h2>
    <p class="lede">Your name, email, the time you picked, your timezone and any answers you give. They are stored in Cloudflare and shown to ${input.ownerName} only.</p>
    <h2 class="section-title">Where it goes</h2>
    <p class="lede">Your name and email go into ${input.ownerName}'s Outlook calendar as the meeting's attendee, so you get an invite. A Google Meet room is created for the meeting; no guest details are sent to Google.</p>
    <h2 class="section-title">Abuse protection</h2>
    <p class="lede">To limit abuse, a one-way hash of your network address is kept with each request. The address itself is not stored.</p>
    <h2 class="section-title">Google and Microsoft access</h2>
    <p class="lede">Wellmet uses ${input.ownerName}'s own Google account only to create Meet rooms, and the Microsoft account only to read busy times and write meetings to that calendar. Data from Google APIs is used for nothing else, is not shared, and is not used for advertising or to train models.</p>
    <h2 class="section-title">Removal</h2>
    <p class="lede">Cancel from your booking link at any time, or write to ${input.ownerName} to have your details removed.</p>`;
  return page({ title: 'Privacy' }, sheet(left, right)).toString();
}

// ---------------------------------------------------------------------------
// 7. Plain message page (not found, try again)

export function renderMessage(input: { title: string; message: string; linkHref?: string; linkText?: string }): string {
  const left = html`${topRow()}<h1 class="headline">${input.title}</h1>`;
  const right = html`<p class="lede">${input.message}</p>${input.linkHref ? html`<p><a class="button button--quiet" href="${input.linkHref}">${input.linkText ?? 'Back'}</a></p>` : ''}`;
  return page({ title: input.title }, sheet(left, right)).toString();
}
