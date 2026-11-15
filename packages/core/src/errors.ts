/**
 * Errors the core returns to its callers. `code` is stable and machine-readable;
 * `message` is written for whoever reads it, a person or an agent, and says
 * what to do next.
 */
export type CoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'slug_taken'
  | 'unknown_schedule'
  | 'schedule_in_use'
  | 'not_bookable'
  | 'slot_taken'
  | 'too_many_requests'
  | 'calendar_unavailable'
  | 'not_allowed';

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

/** Turns a zod error into one readable message: "lengths: Each length can appear once." */
export function invalid(issues: { path: PropertyKey[]; message: string }[]): CoreError {
  const lines = issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message));
  return new CoreError('invalid_input', lines.join(' '), { issues: lines });
}
