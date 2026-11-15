import type { Caller, GuestBooking, PublicEventType, PublicSlot, RequestResult, Result } from '@wellmet/contracts';

/** wellmet-core's PublicApi, as reached over the Service Binding. */
export interface PublicCore {
  ping(): Promise<Result<{ contract: number }>>;
  listEventTypes(): Promise<Result<PublicEventType[]>>;
  getEventType(slug: string): Promise<Result<PublicEventType>>;
  findSlots(slug: string, from: string, to: string, lengthMin?: number): Promise<Result<PublicSlot[]>>;
  requestBooking(input: unknown, caller: Caller): Promise<Result<RequestResult>>;
  getBooking(token: string): Promise<Result<GuestBooking>>;
  cancelBooking(token: string, reason?: string): Promise<Result<GuestBooking>>;
  rescheduleBooking(token: string, newStart: string): Promise<Result<GuestBooking>>;
  reportError(code: string, message: string): Promise<Result<void>>;
}

export interface Config {
  publicUrl: string;
  ownerName: string;
}

/** HTTP status for each core error code, for the JSON API. */
export const STATUS: Record<string, number> = {
  invalid_input: 400,
  not_found: 404,
  not_bookable: 404,
  not_allowed: 403,
  slot_taken: 409,
  too_many_requests: 429,
  calendar_unavailable: 503,
  internal: 500,
};
