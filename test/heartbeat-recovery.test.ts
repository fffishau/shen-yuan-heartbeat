import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatService } from "../src/heartbeat.js";
import type { Env, HeartbeatConfig } from "../src/types.js";
import { createTestDatabase } from "./support/sqlite-d1.js";

const baseNow = new Date("2026-10-18T19:00:00.000Z");

const baseConfig: HeartbeatConfig = {
  timezone: "Asia/Taipei",
  quietStart: "04:00",
  quietEnd: "13:30",
  interactionCooldownMinutes: 20,
  minWakeMinutes: 5,
  maxWakeMinutes: 55,
  maxPushesPerDay: 4,
  reservationLeaseSeconds: 120,
  runLeaseSeconds: 900,
  notificationMaxAttempts: 3,
  notificationRetryMinutes: 5,
  barkMode: "dry-run",
};

describe("heartbeat recovery and notification outbox", () => {
  let fixture: ReturnType<typeof createTestDatabase>;

  beforeEach(() => {
    fixture = createTestDatabase();
    fixture.sqlite
      .prepare(
        `UPDATE heartbeat_state
         SET heartbeat_enabled = 1, push_enabled = 1, next_wake_at = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(baseNow.toISOString(), baseNow.toISOString());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fixture.close();
  });

  it("completes a normal begin to silent commit atomically", async () => {
    seedWake("wake_silent", baseNow);
    const service = createService();
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_silent",
      now: baseNow,
    });

    const nextWakeAt = plusMinutes(baseNow, 20).toISOString();
    const committed = await service.commitDecision(
      {
        runId: begun.runId,
        idempotencyKey: "silent-commit-001",
        action: "silent",
        reason: "No contact needed.",
        nextWakeAt,
      },
      baseNow,
    );

    expect(committed.idempotentReplay).toBe(false);
    expect(row("heartbeat_runs", begun.runId).status).toBe("completed");
    expect(row("wake_events", "wake_silent").status).toBe("completed");
    expect(state().next_wake_at).toBe(nextWakeAt);
    expect(count("notification_outbox")).toBe(0);
  });

  it("queues notify on commit and lets the scheduler simulate Bark", async () => {
    seedWake("wake_notify", baseNow);
    const service = createService();
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_notify",
      now: baseNow,
    });
    const committed = await service.commitDecision(
      {
        runId: begun.runId,
        idempotencyKey: "notify-commit-001",
        action: "notify",
        reason: "A short check-in is appropriate.",
        message: "晚安，記得休息。",
        nextWakeAt: plusMinutes(baseNow, 30).toISOString(),
      },
      baseNow,
    );

    expect((committed.delivery as { status: string }).status).toBe("pending");
    expect(notification(begun.runId).status).toBe("pending");
    await service.schedulerTick(plusSeconds(baseNow, 1));
    expect(notification(begun.runId).status).toBe("simulated");
    expect(count("bark_deliveries")).toBe(1);
  });

  it("never upgrades a notification queued in dry-run to a live Bark send", async () => {
    seedWake("wake_dry_run_stays_dry", baseNow);
    const dryRunService = createService();
    const begun = await dryRunService.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_dry_run_stays_dry",
      now: baseNow,
    });
    await dryRunService.commitDecision(
      {
        runId: begun.runId,
        idempotencyKey: "dry-run-stays-dry-001",
        action: "notify",
        reason: "Preserve the queued delivery mode.",
        message: "不可升級成真實推播。",
        nextWakeAt: plusMinutes(baseNow, 30).toISOString(),
      },
      baseNow,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const liveService = createService({ ...baseConfig, barkMode: "live" }, "device-key");
    await liveService.schedulerTick(plusSeconds(baseNow, 1));

    expect(notification(begun.runId).status).toBe("simulated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expires a claimed wake without Bark or re-ensuring it when commit is missing", async () => {
    const eventId = "wake_20261018190445000";
    seedWake(eventId, baseNow);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = createService({ ...baseConfig, barkMode: "live" }, "device-key");
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId,
      now: baseNow,
    });
    const recoveryAt = plusMinutes(baseNow, 16);
    const result = await service.schedulerTick(recoveryAt);

    expect(result.recoveredRuns).toBe(1);
    expect(row("heartbeat_runs", begun.runId).status).toBe("expired");
    expect(row("wake_events", eventId).status).toBe("expired");
    expect(state().next_wake_at).toBe(plusMinutes(recoveryAt, 5).toISOString());
    expect(auditCount("heartbeat.expire", begun.runId)).toBe(1);
    expect(auditCount("wake_event.ensure", eventId)).toBe(0);
    expect(count("notification_outbox")).toBe(0);
    expect(count("bark_deliveries")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const nextTick = await service.schedulerTick(plusMinutes(recoveryAt, 1));
    expect(nextTick.event).toBeNull();
    expect(auditCount("wake_event.ensure", eventId)).toBe(0);

    await expect(
      service.commitDecision(
        {
          runId: begun.runId,
          idempotencyKey: "expired-run-old-decision",
          action: "notify",
          reason: "The missing decision arrived too late.",
          message: "不應補發。",
          nextWakeAt: plusMinutes(recoveryAt, 21).toISOString(),
        },
        plusMinutes(recoveryAt, 1),
      ),
    ).rejects.toThrow(/expired/u);
    expect(count("notification_outbox")).toBe(0);
    expect(count("bark_deliveries")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not recover a run before its lease expires", async () => {
    seedWake("wake_live_lease", baseNow);
    const service = createService();
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_live_lease",
      now: baseNow,
    });
    const result = await service.schedulerTick(plusMinutes(baseNow, 14));

    expect(result.recoveredRuns).toBe(0);
    expect(row("heartbeat_runs", begun.runId).status).toBe("started");
    expect(row("wake_events", "wake_live_lease").status).toBe("claimed");
  });

  it("replays duplicate commit without duplicating the notification", async () => {
    seedWake("wake_duplicate_commit", baseNow);
    const service = createService();
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_duplicate_commit",
      now: baseNow,
    });
    const input = {
      runId: begun.runId,
      idempotencyKey: "duplicate-commit-001",
      action: "notify" as const,
      reason: "One message only.",
      message: "只送一次。",
      nextWakeAt: plusMinutes(baseNow, 25).toISOString(),
    };
    const first = await service.commitDecision(input, baseNow);
    const second = await service.commitDecision(input, plusSeconds(baseNow, 1));

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(count("notification_outbox")).toBe(1);
  });

  it("serializes simultaneous duplicate commits without duplicate audit rows", async () => {
    seedWake("wake_simultaneous_commit", baseNow);
    const service = createService();
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_simultaneous_commit",
      now: baseNow,
    });
    const input = {
      runId: begun.runId,
      idempotencyKey: "simultaneous-commit-001",
      action: "notify" as const,
      reason: "One atomic commit.",
      message: "只提交一次。",
      nextWakeAt: plusMinutes(baseNow, 25).toISOString(),
    };

    const results = await Promise.all([
      service.commitDecision(input, baseNow),
      service.commitDecision(input, baseNow),
    ]);

    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(count("notification_outbox")).toBe(1);
    expect(auditCount("heartbeat.complete", begun.runId)).toBe(1);
  });

  it("allows only one active run for the same wake under concurrent begin", async () => {
    seedWake("wake_concurrent_begin", baseNow);
    const service = createService();
    const attempts = await Promise.allSettled([
      service.beginOfficialCycle({
        source: "chatgpt-automation",
        eventId: "wake_concurrent_begin",
        now: baseNow,
      }),
      service.beginOfficialCycle({
        source: "chatgpt-automation",
        eventId: "wake_concurrent_begin",
        now: baseNow,
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) AS count FROM heartbeat_runs WHERE wake_event_id = ?")
        .get("wake_concurrent_begin") as { count: number },
    ).toEqual({ count: 1 });
  });

  it("does not duplicate scheduler wake creation or notification dispatch", async () => {
    const service = createService();
    await Promise.all([service.schedulerTick(baseNow), service.schedulerTick(baseNow)]);
    expect(count("wake_events")).toBe(1);

    const eventId = (
      fixture.sqlite.prepare("SELECT id FROM wake_events LIMIT 1").get() as { id: string }
    ).id;
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId,
      now: baseNow,
    });
    await service.commitDecision(
      {
        runId: begun.runId,
        idempotencyKey: "concurrent-scheduler-001",
        action: "notify",
        reason: "One queued notification.",
        message: "一次就好。",
        nextWakeAt: plusMinutes(baseNow, 30).toISOString(),
      },
      baseNow,
    );
    await Promise.all([
      service.schedulerTick(plusSeconds(baseNow, 1)),
      service.schedulerTick(plusSeconds(baseNow, 1)),
    ]);
    expect(notification(begun.runId).attempts).toBe(1);
  });

  it("retries definitive Bark failure and records one logical delivery", async () => {
    seedWake("wake_retry", baseNow);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = createService({ ...baseConfig, barkMode: "live" }, "device-key");
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_retry",
      now: baseNow,
    });
    await service.commitDecision(
      {
        runId: begun.runId,
        idempotencyKey: "retry-notification-001",
        action: "notify",
        reason: "Retry a definitive HTTP failure.",
        message: "重試測試。",
        nextWakeAt: plusMinutes(baseNow, 30).toISOString(),
      },
      baseNow,
    );

    await service.schedulerTick(plusSeconds(baseNow, 1));
    expect(notification(begun.runId).status).toBe("pending");
    await service.schedulerTick(plusMinutes(baseNow, 6));
    expect(notification(begun.runId).status).toBe("sent");
    expect(notification(begun.runId).attempts).toBe(2);
    expect(count("bark_deliveries")).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks an unknown Bark result uncertain and does not auto-retry", async () => {
    seedWake("wake_uncertain", baseNow);
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset after write"));
    vi.stubGlobal("fetch", fetchMock);
    const service = createService({ ...baseConfig, barkMode: "live" }, "device-key");
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_uncertain",
      now: baseNow,
    });
    await service.commitDecision(
      {
        runId: begun.runId,
        idempotencyKey: "uncertain-notification-001",
        action: "notify",
        reason: "Unknown provider result.",
        message: "不確定結果。",
        nextWakeAt: plusMinutes(baseNow, 30).toISOString(),
      },
      baseNow,
    );

    await service.schedulerTick(plusSeconds(baseNow, 1));
    expect(notification(begun.runId).status).toBe("uncertain");
    await service.schedulerTick(plusMinutes(baseNow, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a late commit after expiry without changing the recovered schedule", async () => {
    seedWake("wake_late_commit", baseNow);
    const service = createService();
    const begun = await service.beginOfficialCycle({
      source: "chatgpt-automation",
      eventId: "wake_late_commit",
      now: baseNow,
    });
    const recoveryAt = plusMinutes(baseNow, 16);
    await service.schedulerTick(recoveryAt);
    const recoveredNextWake = state().next_wake_at;

    await expect(
      service.commitDecision(
        {
          runId: begun.runId,
          idempotencyKey: "late-commit-001",
          action: "notify",
          reason: "Too late.",
          message: "不應送出。",
          nextWakeAt: plusMinutes(recoveryAt, 20).toISOString(),
        },
        recoveryAt,
      ),
    ).rejects.toThrow(/expired/u);
    expect(state().next_wake_at).toBe(recoveredNextWake);
    expect(count("notification_outbox")).toBe(0);
  });

  function createService(
    config: HeartbeatConfig = baseConfig,
    barkDeviceKey?: string,
  ): HeartbeatService {
    const env: Env = {
      DB: fixture.db,
      BARK_MODE: config.barkMode,
      ...(barkDeviceKey ? { BARK_DEVICE_KEY: barkDeviceKey } : {}),
    };
    return new HeartbeatService(env, config);
  }

  function seedWake(id: string, at: Date): void {
    fixture.sqlite
      .prepare(
        `INSERT INTO wake_events
          (id, source, reason, visible_text, model_context, status, created_at, eligible_until)
         VALUES (?, 'test', 'due', 'visible', 'context', 'pending', ?, ?)`,
      )
      .run(id, at.toISOString(), plusMinutes(at, 75).toISOString());
  }

  function state(): Record<string, unknown> {
    return fixture.sqlite.prepare("SELECT * FROM heartbeat_state WHERE id = 1").get() as Record<
      string,
      unknown
    >;
  }

  function row(table: "heartbeat_runs" | "wake_events", id: string): Record<string, unknown> {
    return fixture.sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >;
  }

  function notification(runId: string): Record<string, unknown> {
    return fixture.sqlite
      .prepare("SELECT * FROM notification_outbox WHERE run_id = ?")
      .get(runId) as Record<string, unknown>;
  }

  function count(table: "wake_events" | "notification_outbox" | "bark_deliveries"): number {
    return (fixture.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
      .count;
  }

  function auditCount(action: string, subjectId: string): number {
    return (
      fixture.sqlite
        .prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND subject_id = ?")
        .get(action, subjectId) as { count: number }
    ).count;
  }
});

function plusMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function plusSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
