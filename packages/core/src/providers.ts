/**
 * What the booking logic needs from Outlook and Google Meet. The real
 * implementations call Microsoft Graph and the Meet REST API; tests use fakes
 * that can be made slow or failing at any step.
 */

export interface CalendarEvent {
  id: string;
  /** Set on events this scheduler created: the booking id. */
  transactionId: string | null;
  start: number;
  end: number;
  /** False for events marked free or cancelled; those don't block time. */
  busy: boolean;
}

export interface NewEvent {
  /** The booking id. Graph uses it to refuse a duplicate create. */
  transactionId: string;
  subject: string;
  body: string;
  start: number;
  end: number;
  timezone: string;
  /** Absent for a block of busy time Tom adds himself. */
  attendee?: { name: string; email: string };
  location: string;
}

export interface CalendarProvider {
  /** Events overlapping [from, to). */
  listEvents(from: number, to: number): Promise<CalendarEvent[]>;
  createEvent(event: NewEvent): Promise<{ id: string }>;
  updateEvent(id: string, patch: Partial<Pick<NewEvent, 'start' | 'end' | 'body' | 'location' | 'timezone'>>): Promise<void>;
  cancelEvent(id: string, comment: string): Promise<void>;
  /** Removes an event that has no attendees, such as a block. */
  deleteEvent(id: string): Promise<void>;
}

export interface MeetProvider {
  createSpace(): Promise<{ url: string }>;
}

/** The provider didn't answer, or answered with a server error. Worth retrying. */
export class ProviderUnavailable extends Error {
  constructor(readonly provider: 'microsoft' | 'google', message: string) {
    super(message);
    this.name = 'ProviderUnavailable';
  }
}

/** The connection itself is broken (revoked token, expired client secret). Needs Tom. */
export class ProviderBroken extends Error {
  constructor(readonly provider: 'microsoft' | 'google', readonly reason: string) {
    super(reason);
    this.name = 'ProviderBroken';
  }
}

/** Rejects with ProviderUnavailable if `work` takes longer than `ms`. */
export function withTimeout<T>(provider: 'microsoft' | 'google', ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderUnavailable(provider, `No answer within ${ms} ms.`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
