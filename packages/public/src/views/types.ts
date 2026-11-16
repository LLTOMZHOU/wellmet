/**
 * View models for the public pages. The public Worker builds these from what
 * the core returns; the templates only format them. Every time here is
 * already converted to the visitor's timezone and formatted for display.
 */

export interface Host {
  name: string;
}

export type ConfirmationMode = 'instant' | 'approval';

export interface EventTypeSummary {
  slug: string;
  title: string;
  description: string;
  durationMin: number;
  /** For example "Google Meet". */
  location: string;
  mode: ConfirmationMode;
  href: string;
}

export interface Slot {
  /** ISO-8601 with offset, as an agent would send it back. */
  start: string;
  /** "14:30" in the visitor's timezone. */
  label: string;
  href: string;
}

/** One cell of the month calendar. */
export interface CalendarDate {
  day: number;
  /** "2026-11-19": ties the calendar cell to its day's times on the page. */
  date: string;
  /** Link that shows this date's times; null when nothing can be booked. */
  href: string | null;
  /** Open times on this date, for the bar under the number. */
  openCount: number;
  state: 'past' | 'closed' | 'open' | 'selected';
}

export interface Month {
  /** "November 2026" */
  label: string;
  prevHref: string | null;
  prevLabel: string;
  nextHref: string | null;
  nextLabel: string;
  /** Empty cells before the 1st, with weeks starting on Sunday. */
  leadingBlanks: number;
  dates: CalendarDate[];
}

/** A day and its open times. */
export interface Day {
  /** "Tuesday" */
  weekday: string;
  /** "17 November" */
  date: string;
  /** "Tue 17" for compact lists. */
  short: string;
  slots: Slot[];
}

export interface Timezone {
  /** IANA name, for example "Europe/Paris". */
  current: string;
  /** Common choices for the switcher; the current one is included. */
  options: string[];
  /** Path the switcher form submits to, with its other query values. */
  action: string;
  hidden: Record<string, string>;
}

export interface AgentInfo {
  /** The one line a visitor copies into their own assistant. */
  copyLine: string;
  mcpUrl: string;
  slotsUrl: string;
  bookingsUrl: string;
  /** The OpenAPI description of the JSON API. */
  openapiUrl: string;
  slug: string;
}

export interface Question {
  id: string;
  label: string;
  required: boolean;
  multiline: boolean;
}

export interface ChosenSlot {
  start: string;
  /** "Tuesday" */
  weekday: string;
  /** "17 November" */
  date: string;
  /** "14:30 – 15:00" */
  timeLine: string;
}

export interface FieldValues {
  name: string;
  email: string;
  answers: Record<string, string>;
}

export type FieldErrors = Partial<Record<string, string>>;

export type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'expired' | 'cancelled';

export interface BookingReceipt {
  status: BookingStatus;
  title: string;
  guestName: string;
  weekday: string;
  date: string;
  timeLine: string;
  timezone: string;
  location: string;
  /** Present once the Meet room exists. */
  meetUrl: string | null;
  cancelAction: string | null;
  rescheduleHref: string | null;
  reschedulesLeft: number;
  /** For example "Cancelled on 15 November." */
  note: string | null;
}
