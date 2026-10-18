import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type BoundValue = string | number | null | ArrayBuffer | ArrayBufferView;

class SqlitePreparedStatement {
  constructor(
    private readonly database: Database.Database,
    readonly sql: string,
    readonly bindings: BoundValue[] = [],
  ) {}

  bind(...values: BoundValue[]): D1PreparedStatement {
    return new SqlitePreparedStatement(this.database, this.sql, values) as unknown as D1PreparedStatement;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.bindings) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (/\bRETURNING\b/iu.test(this.sql)) {
      const rows = this.database.prepare(this.sql).all(...this.bindings) as T[];
      return result(rows, rows.length);
    }
    const info = this.database.prepare(this.sql).run(...this.bindings);
    return result<T>([], info.changes);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.sql).all(...this.bindings) as T[];
    return result(rows, 0);
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.database.prepare(this.sql).raw().all(...this.bindings) as T[];
  }
}

class SqliteD1Database {
  constructor(readonly sqlite: Database.Database) {}

  prepare(sql: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this.sqlite, sql) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const execute = this.sqlite.transaction(() =>
      statements.map((statement) => {
        const prepared = statement as unknown as SqlitePreparedStatement;
        if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/iu.test(prepared.sql)) {
          const rows = this.sqlite.prepare(prepared.sql).all(...prepared.bindings) as T[];
          return result(rows, rows.length);
        }
        const info = this.sqlite.prepare(prepared.sql).run(...prepared.bindings);
        return result<T>([], info.changes);
      }),
    );
    return execute();
  }

  async exec(sql: string): Promise<D1ExecResult> {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

function result<T>(rows: T[], changes: number): D1Result<T> {
  return {
    results: rows,
    success: true,
    meta: { changes },
  } as unknown as D1Result<T>;
}

export function createTestDatabase(): {
  db: D1Database;
  sqlite: Database.Database;
  close: () => void;
} {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const migration of [
    "0001_init.sql",
    "0002_run_idempotency.sql",
    "0003_oauth_rate_limit.sql",
    "0004_run_recovery_outbox.sql",
  ]) {
    sqlite.exec(readFileSync(resolve("migrations", migration), "utf8"));
  }
  return {
    db: new SqliteD1Database(sqlite) as unknown as D1Database,
    sqlite,
    close: () => sqlite.close(),
  };
}
