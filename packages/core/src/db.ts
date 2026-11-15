/**
 * The slice of Cloudflare D1's API the core uses. The real `D1Database`
 * binding satisfies it, and tests run the same SQL on SQLite through a small
 * adapter, so queries are tested as written.
 */
export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number; last_row_id: number };
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run(): Promise<DbResult>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  /** Runs the statements as one transaction: all or nothing. */
  batch(statements: DbStatement[]): Promise<DbResult[]>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
