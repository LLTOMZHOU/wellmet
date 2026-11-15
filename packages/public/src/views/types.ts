/**
 * View models for the public pages. The public Worker builds these from what
 * the core returns; the templates only format them. Every time here is
 * already converted to the visitor's timezone and formatted for display.
 */

export interface Host {
  name: string;
  /** One short line under the name, such as a role. Optional. */
  tagline?: string;
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

export interface Day {
  /** "Mon" */
  weekday: string;
  /** "Apr 21" */
  monthDay: string;
  slots: Slot[];
}

export interface Week {
  /** "Apr 21 – 27" */
  label: string;
  prevHref: string | null;
  nextHref: string | null;
  /** Only days with at least one open time. */
  days: Day[];
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
  pageUrl: string;
  mcpUrl: string;
  slotsUrl: string;
  bookingsUrl: string;
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
  /** "Wednesday, April 23" */
  dateLine: string;
  /** "14:00 – 14:30" */
  timeLine: string;
}

export interface FieldValues {
  name: string;
  email: string;
  answers: Record<string, string>;
}

export type FieldErrors = Partial<Record<'name' | 'email' | string, string>>;

export type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'expired' | 'cancelled';

export interface BookingReceipt {
  status: BookingStatus;
  title: string;
  guestName: string;
  dateLine: string;
  timeLine: string;
  timezone: string;
  location: string;
  /** Present once the Meet room exists. */
  meetUrl: string | null;
  cancelAction: string | null;
  rescheduleHref: string | null;
  reschedulesLeft: number;
  /** For example "Cancelled on April 22". */
  note: string | null;
}
