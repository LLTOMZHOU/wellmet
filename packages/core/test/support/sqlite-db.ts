import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, DbResult, DbStatement } from '../../src/db.ts';

/**
 * D1's API over Node's built-in SQLite, for tests. D1 is SQLite too, so the
 * core's SQL runs here unchanged; `batch` is a real transaction as in D1.
 */
export function sqliteDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const dir = join(import.meta.dirname, '../../migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, file), 'utf8'));
  }

  const toSql = (v: unknown): SQLInputValue => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as SQLInputValue;
  };

  class Statement implements DbStatement {
    constructor(readonly sql: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: unknown[]): DbStatement {
      return new Statement(this.sql, values.map(toSql));
    }
    exec(): DbResult {
      const stmt = raw.prepare(this.sql);
      if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) {
        const rows = stmt.all(...this.values) as Record<string, unknown>[];
        return { results: rows.map((r) => ({ ...r })), meta: { changes: 0, last_row_id: 0 } };
      }
      const r = stmt.run(...this.values);
      return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async first<T>(): Promise<T | null> {
      return (this.exec().results[0] as T | undefined) ?? null;
    }
    async all<T>(): Promise<DbResult<T>> {
      return this.exec() as DbResult<T>;
    }
    async run(): Promise<DbResult> {
      return this.exec();
    }
  }

  return {
    raw,
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const out = statements.map((s) => (s as Statement).exec());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
