import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("run recovery migration", () => {
  it("normalizes duplicate legacy active runs before adding the unique index", () => {
    const db = new Database(":memory:");
    try {
      apply(db, "0001_init.sql");
      apply(db, "0002_run_idempotency.sql");
      apply(db, "0003_oauth_rate_limit.sql");
      db.prepare(
        `INSERT INTO wake_events
          (id, source, reason, visible_text, model_context, status, created_at, eligible_until)
         VALUES ('wake_legacy', 'test', 'due', 'visible', 'context', 'claimed',
                 '2026-10-18T18:00:00.000Z', '2026-10-18T20:00:00.000Z')`,
      ).run();
      const insertRun = db.prepare(
        `INSERT INTO heartbeat_runs
          (id, wake_event_id, source, status, started_at)
         VALUES (?, 'wake_legacy', 'test', 'started', ?)`,
      );
      insertRun.run("run_older", "2026-10-18T18:01:00.000Z");
      insertRun.run("run_newer", "2026-10-18T18:02:00.000Z");

      apply(db, "0004_run_recovery_outbox.sql");

      expect(
        db.prepare("SELECT status, error FROM heartbeat_runs WHERE id = 'run_older'").get(),
      ).toEqual({ status: "expired", error: "migration_duplicate_active_run" });
      expect(
        db.prepare("SELECT status, lease_expires_at FROM heartbeat_runs WHERE id = 'run_newer'").get(),
      ).toEqual({ status: "started", lease_expires_at: null });
      expect(
        db
          .prepare(
            `SELECT count(*) AS count FROM audit_log
             WHERE action = 'heartbeat.expire' AND subject_id = 'run_older'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(() =>
        insertActiveRun(db, "run_third", "wake_legacy"),
      ).toThrow(/UNIQUE constraint failed/u);
    } finally {
      db.close();
    }
  });
});

function apply(db: Database.Database, migration: string): void {
  db.exec(readFileSync(resolve("migrations", migration), "utf8"));
}

function insertActiveRun(db: Database.Database, runId: string, wakeId: string): void {
  db.prepare(
    `INSERT INTO heartbeat_runs
      (id, wake_event_id, source, status, started_at, lease_expires_at)
     VALUES (?, ?, 'test', 'started', '2026-10-18T18:03:00.000Z',
             '2026-10-18T18:18:00.000Z')`,
  ).run(runId, wakeId);
}
