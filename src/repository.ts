import { randomId } from "./crypto.js";
import { addMinutes, iso, localDay, parseIso } from "./time.js";
import type {
  HeartbeatConfig,
  HeartbeatState,
  WakeEvent,
} from "./types.js";

type StateRow = {
  heartbeat_enabled: number;
  push_enabled: number;
  life_events_enabled: number;
  last_scheduler_tick_at: string | null;
  last_official_wake_at: string | null;
  next_wake_at: string | null;
  last_bark_at: string | null;
  last_bark_event_id: string | null;
  awaiting_response_since: string | null;
  last_interaction_at: string | null;
  last_skip_reason: string | null;
  last_error: string | null;
  updated_at: string;
};

type WakeRow = {
  id: string;
  kind: string;
  source: string;
  reason: string;
  visible_text: string;
  model_context: string;
  status: WakeEvent["status"];
  created_at: string;
  eligible_until: string;
  attempts: number;
};

type RunStatus = "started" | "completed" | "failed" | "expired";

type RunRow = {
  id: string;
  wake_event_id: string | null;
  status: RunStatus;
  started_at: string;
  lease_expires_at: string | null;
  completed_at: string | null;
  idempotency_key: string | null;
  decision: string | null;
  skip_reason: string | null;
  next_wake_at: string | null;
  bark_event_id: string | null;
  error: string | null;
};

export type NotificationOutboxItem = {
  id: string;
  runId: string;
  idempotencyKey: string;
  mode: "dry-run" | "live";
  title: string;
  body: string;
  targetUrl: string | null;
  status: "sending";
  attempts: number;
  leaseToken: string;
};

type UsageRow = {
  day: string;
  scheduler_ticks: number;
  official_wakes: number;
  mcp_calls: number;
  bark_attempts: number;
  bark_sent: number;
  life_event_reads: number;
  d1_writes_estimate: number;
};

export class Repository {
  constructor(private readonly db: D1Database) {}

  async state(): Promise<HeartbeatState> {
    const row = await this.db
      .prepare("SELECT * FROM heartbeat_state WHERE id = 1")
      .first<StateRow>();
    if (!row) throw new Error("heartbeat_state is not initialized");
    return {
      heartbeatEnabled: row.heartbeat_enabled === 1,
      pushEnabled: row.push_enabled === 1,
      lifeEventsEnabled: row.life_events_enabled === 1,
      lastSchedulerTickAt: row.last_scheduler_tick_at,
      lastOfficialWakeAt: row.last_official_wake_at,
      nextWakeAt: row.next_wake_at,
      lastBarkAt: row.last_bark_at,
      lastBarkEventId: row.last_bark_event_id,
      awaitingResponseSince: row.awaiting_response_since,
      lastInteractionAt: row.last_interaction_at,
      lastSkipReason: row.last_skip_reason,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    };
  }

  async usage(day: string): Promise<UsageRow> {
    return (
      (await this.db
        .prepare("SELECT * FROM usage_daily WHERE day = ?")
        .bind(day)
        .first<UsageRow>()) ?? {
        day,
        scheduler_ticks: 0,
        official_wakes: 0,
        mcp_calls: 0,
        bark_attempts: 0,
        bark_sent: 0,
        life_event_reads: 0,
        d1_writes_estimate: 0,
      }
    );
  }

  async incrementUsage(
    day: string,
    field:
      | "scheduler_ticks"
      | "official_wakes"
      | "mcp_calls"
      | "bark_attempts"
      | "bark_sent"
      | "life_event_reads"
      | "d1_writes_estimate",
    amount = 1,
  ): Promise<void> {
    const allowed = new Set([
      "scheduler_ticks",
      "official_wakes",
      "mcp_calls",
      "bark_attempts",
      "bark_sent",
      "life_event_reads",
      "d1_writes_estimate",
    ]);
    if (!allowed.has(field)) throw new Error("Invalid usage field");
    await this.db
      .prepare(
        `INSERT INTO usage_daily (day, ${field}) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
      )
      .bind(day, amount)
      .run();
  }

  async schedulerTick(
    now: Date,
    config: HeartbeatConfig,
  ): Promise<{ event: WakeEvent | null; reason: string; recoveredRuns: number }> {
    const nowIso = iso(now);
    const day = localDay(now, config.timezone);
    const recovery = await this.recoverExpiredRuns(now, config);
    const orphanCutoff = iso(new Date(now.getTime() - config.runLeaseSeconds * 1000));
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE heartbeat_state SET last_scheduler_tick_at = ?, updated_at = ? WHERE id = 1",
        )
        .bind(nowIso, nowIso),
      this.db
        .prepare(
          `INSERT INTO usage_daily (day, scheduler_ticks, d1_writes_estimate)
           VALUES (?, 1, 2)
           ON CONFLICT(day) DO UPDATE SET
             scheduler_ticks = scheduler_ticks + 1,
             d1_writes_estimate = d1_writes_estimate + 2`,
        )
        .bind(day),
      this.db
        .prepare(
          `UPDATE wake_events
           SET status = 'expired', last_error = 'eligibility_window_elapsed'
           WHERE status IN ('pending', 'reserved') AND eligible_until < ?`,
        )
        .bind(nowIso),
      this.db
        .prepare(
          `UPDATE wake_events
           SET status = 'pending', reserved_at = NULL, reserved_by = NULL,
               lease_expires_at = NULL, last_error = 'reservation_lease_expired'
           WHERE status = 'reserved' AND lease_expires_at < ? AND eligible_until >= ?`,
        )
        .bind(nowIso, nowIso),
      this.db
        .prepare(
          `UPDATE wake_events
           SET status = 'expired', completed_at = ?, last_error = 'orphaned_claim'
           WHERE status = 'claimed' AND claimed_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM heartbeat_runs
               WHERE wake_event_id = wake_events.id AND status = 'started'
             )`,
        )
        .bind(nowIso, orphanCutoff),
    ]);

    const state = await this.state();
    if (!state.heartbeatEnabled) {
      return { event: null, reason: "heartbeat_paused", recoveredRuns: recovery.count };
    }
    const next = parseIso(state.nextWakeAt);
    if (!next) {
      return { event: null, reason: "next_wake_not_set", recoveredRuns: recovery.count };
    }
    if (next.getTime() > now.getTime()) {
      return {
        event: null,
        reason: recovery.count > 0 ? "expired_run_recovered" : "not_due",
        recoveredRuns: recovery.count,
      };
    }

    const eventId = `wake_${state.nextWakeAt!.replaceAll(/[^0-9]/g, "")}`;
    const eligibleUntil = iso(addMinutes(now, 75));
    const reason = "scheduled_next_wake_at_reached";
    const visibleText =
      "沉淵的自主心跳到了。請先恢復 Warmup，再依目前狀態決定是否需要聯絡涵。";
    const modelContext = [
      `eventId=${eventId}`,
      `scheduledFor=${state.nextWakeAt}`,
      "source=shen-yuan-heartbeat-worker",
      "This is an official wake request, not permission to fabricate a reply outside ChatGPT.",
      "Read Shen Yuan Warmup before making any relationship-facing decision.",
      "A silent decision is valid.",
    ].join("\n");

    await this.db
      .prepare(
        `INSERT OR IGNORE INTO wake_events
          (id, source, reason, visible_text, model_context, status, created_at, eligible_until)
         VALUES (?, 'cloudflare-scheduler', ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(eventId, reason, visibleText, modelContext, nowIso, eligibleUntil)
      .run();
    const event = await this.wakeEvent(eventId);
    await this.audit(now, "scheduler", "wake_event.ensure", "ok", eventId, {
      scheduledFor: state.nextWakeAt,
    });
    return {
      event,
      reason: event?.status === "pending" ? "wake_enqueued" : "wake_exists",
      recoveredRuns: recovery.count,
    };
  }

  async recoverExpiredRuns(
    now: Date,
    config: HeartbeatConfig,
  ): Promise<{ count: number; nextWakeAt: string | null }> {
    const nowIso = iso(now);
    const nextWakeAt = iso(addMinutes(now, config.minWakeMinutes));
    const details = JSON.stringify({
      reason: "run_lease_expired",
      recoveryNextWakeAt: nextWakeAt,
    });
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO audit_log
            (id, at, actor, action, outcome, subject_id, details_json)
           SELECT 'audit_' || lower(hex(randomblob(16))), ?, 'scheduler',
                  'heartbeat.expire', 'ok', id, ?
           FROM heartbeat_runs
           WHERE status = 'started'
             AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        )
        .bind(nowIso, details, nowIso),
      this.db
        .prepare(
          `UPDATE wake_events
           SET status = 'expired', completed_at = ?, last_error = 'run_lease_expired'
           WHERE id IN (
             SELECT wake_event_id FROM heartbeat_runs
             WHERE status = 'started'
               AND (lease_expires_at IS NULL OR lease_expires_at < ?)
               AND wake_event_id IS NOT NULL
           ) AND status = 'claimed'`,
        )
        .bind(nowIso, nowIso),
      this.db
        .prepare(
          `UPDATE heartbeat_state
           SET next_wake_at = ?, last_skip_reason = 'run_lease_expired', updated_at = ?
           WHERE id = 1 AND (next_wake_at IS NULL OR next_wake_at <= ?)
             AND EXISTS (
               SELECT 1 FROM heartbeat_runs
               WHERE status = 'started'
                 AND (lease_expires_at IS NULL OR lease_expires_at < ?)
             )`,
        )
        .bind(nextWakeAt, nowIso, nowIso, nowIso),
      this.db
        .prepare(
          `UPDATE heartbeat_runs
           SET status = 'expired', completed_at = ?, error = 'run_lease_expired'
           WHERE status = 'started'
             AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        )
        .bind(nowIso, nowIso),
    ]);
    const count = results[3]?.meta.changes ?? 0;
    return { count, nextWakeAt: count > 0 ? nextWakeAt : null };
  }

  async wakeEvent(eventId: string): Promise<WakeEvent | null> {
    const row = await this.db
      .prepare("SELECT * FROM wake_events WHERE id = ?")
      .bind(eventId)
      .first<WakeRow>();
    return row ? mapWake(row) : null;
  }

  async reserveNext(
    now: Date,
    listenerId: string,
    leaseSeconds: number,
  ): Promise<WakeEvent | null> {
    const nowIso = iso(now);
    const leaseExpiresAt = iso(new Date(now.getTime() + leaseSeconds * 1000));
    const row = await this.db
      .prepare(
        `UPDATE wake_events
         SET status = 'reserved', reserved_at = ?, reserved_by = ?,
             lease_expires_at = ?, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM wake_events
           WHERE status = 'pending' AND eligible_until >= ? AND attempts < 3
           ORDER BY created_at ASC LIMIT 1
         )
         RETURNING *`,
      )
      .bind(nowIso, listenerId, leaseExpiresAt, nowIso)
      .first<WakeRow>();
    return row ? mapWake(row) : null;
  }

  async markHostSent(eventId: string, now: Date): Promise<void> {
    await this.db
      .prepare(
        `UPDATE wake_events
         SET status = 'host_sent', host_sent_at = ?, lease_expires_at = NULL
         WHERE id = ? AND status IN ('reserved', 'host_sent')`,
      )
      .bind(iso(now), eventId)
      .run();
  }

  async release(eventId: string, now: Date, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE wake_events
         SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
             reserved_at = NULL, reserved_by = NULL, lease_expires_at = NULL,
             last_error = ?
         WHERE id = ? AND status = 'reserved'`,
      )
      .bind(error.slice(0, 500), eventId)
      .run();
    await this.audit(now, "bridge", "wake_event.release", "ok", eventId, {
      error: error.slice(0, 200),
    });
  }

  async beginRun(
    now: Date,
    config: HeartbeatConfig,
    source: string,
    eventId?: string,
  ): Promise<{ runId: string; event: WakeEvent | null; state: HeartbeatState }> {
    const nowIso = iso(now);
    const candidateId =
      eventId ??
      (
        await this.db
          .prepare(
            `SELECT id FROM wake_events
             WHERE status IN ('pending', 'host_sent') AND eligible_until >= ?
               AND NOT EXISTS (
                 SELECT 1 FROM heartbeat_runs
                 WHERE wake_event_id = wake_events.id AND status = 'started'
               )
             ORDER BY created_at ASC LIMIT 1`,
          )
          .bind(nowIso)
          .first<{ id: string }>()
      )?.id;
    if (!candidateId) throw new Error("No eligible heartbeat wake event.");

    const runId = randomId("run");
    const leaseExpiresAt = iso(new Date(now.getTime() + config.runLeaseSeconds * 1000));
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE wake_events
           SET status = 'claimed', claimed_at = ?, lease_expires_at = ?
           WHERE id = ? AND status IN ('pending', 'reserved', 'host_sent')
             AND eligible_until >= ?
             AND NOT EXISTS (
               SELECT 1 FROM heartbeat_runs
               WHERE wake_event_id = wake_events.id AND status = 'started'
             )`,
        )
        .bind(nowIso, leaseExpiresAt, candidateId, nowIso),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO heartbeat_runs
            (id, wake_event_id, source, status, started_at, lease_expires_at)
           SELECT ?, ?, ?, 'started', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM wake_events
             WHERE id = ? AND status = 'claimed' AND claimed_at = ?
           )`,
        )
        .bind(runId, candidateId, source, nowIso, leaseExpiresAt, candidateId, nowIso),
      this.db
        .prepare(
          `UPDATE heartbeat_state
           SET last_official_wake_at = ?, last_error = NULL, updated_at = ?
           WHERE id = 1 AND EXISTS (SELECT 1 FROM heartbeat_runs WHERE id = ?)`,
        )
        .bind(nowIso, nowIso, runId),
      this.db
        .prepare(
          `INSERT INTO usage_daily (day, official_wakes, mcp_calls, d1_writes_estimate)
           SELECT ?, 1, 1, 3 WHERE EXISTS (SELECT 1 FROM heartbeat_runs WHERE id = ?)
           ON CONFLICT(day) DO UPDATE SET
             official_wakes = official_wakes + 1,
             mcp_calls = mcp_calls + 1,
             d1_writes_estimate = d1_writes_estimate + 3`,
        )
        .bind(localDay(now, config.timezone), runId),
      this.db
        .prepare(
          `INSERT INTO audit_log (id, at, actor, action, outcome, subject_id, details_json)
           SELECT ?, ?, ?, 'heartbeat.begin', 'ok', ?, ?
           WHERE EXISTS (SELECT 1 FROM heartbeat_runs WHERE id = ?)`,
        )
        .bind(
          randomId("audit"),
          nowIso,
          source,
          runId,
          JSON.stringify({ eventId: candidateId, leaseExpiresAt }),
          runId,
        ),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error("Heartbeat wake event is already claimed or no longer eligible.");
    }
    const event = await this.wakeEvent(candidateId);
    return { runId, event, state: await this.state() };
  }

  async pushesToday(day: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT bark_sent FROM usage_daily WHERE day = ?")
      .bind(day)
      .first<{ bark_sent: number }>();
    return row?.bark_sent ?? 0;
  }

  async run(runId: string): Promise<{
    id: string;
    wakeEventId: string | null;
    status: RunStatus;
    startedAt: string;
    leaseExpiresAt: string | null;
    completedAt: string | null;
    idempotencyKey: string | null;
    decision: string | null;
    skipReason: string | null;
    nextWakeAt: string | null;
    barkEventId: string | null;
    error: string | null;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, wake_event_id, status, started_at, lease_expires_at,
                completed_at, idempotency_key, decision, skip_reason,
                next_wake_at, bark_event_id, error
         FROM heartbeat_runs WHERE id = ?`,
      )
      .bind(runId)
      .first<RunRow>();
    return row
      ? {
          id: row.id,
          wakeEventId: row.wake_event_id,
          status: row.status,
          startedAt: row.started_at,
          leaseExpiresAt: row.lease_expires_at,
          completedAt: row.completed_at,
          idempotencyKey: row.idempotency_key,
          decision: row.decision,
          skipReason: row.skip_reason,
          nextWakeAt: row.next_wake_at,
          barkEventId: row.bark_event_id,
          error: row.error,
        }
      : null;
  }

  async runByIdempotencyKey(idempotencyKey: string) {
    const row = await this.db
      .prepare("SELECT id FROM heartbeat_runs WHERE idempotency_key = ?")
      .bind(idempotencyKey)
      .first<{ id: string }>();
    return row ? this.run(row.id) : null;
  }

  async commitRun(input: {
    runId: string;
    idempotencyKey: string;
    now: Date;
    decision: "silent" | "notify";
    reason: string;
    skipReason: string | null;
    nextWakeAt: string;
    outboxId: string | null;
    outboxStatus: "pending" | "blocked" | null;
    outboxMode: "dry-run" | "live";
    notificationTitle: string | null;
    notificationBody: string | null;
    notificationTargetUrl: string | null;
    observedInteractionAt?: string;
  }): Promise<{ committed: boolean }> {
    const nowIso = iso(input.now);
    const commitToken = randomId("commit");
    const interaction = input.observedInteractionAt
      ? parseIso(input.observedInteractionAt)?.toISOString()
      : null;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE heartbeat_runs
           SET status = 'completed', completed_at = ?, idempotency_key = ?, decision = ?,
               decision_reason = ?, skip_reason = ?, next_wake_at = ?, commit_token = ?
           WHERE id = ? AND status = 'started' AND lease_expires_at >= ?`,
        )
        .bind(
          nowIso,
          input.idempotencyKey,
          input.decision,
          input.reason,
          input.skipReason,
          input.nextWakeAt,
          commitToken,
          input.runId,
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE heartbeat_state
           SET next_wake_at = ?, last_skip_reason = ?,
               last_interaction_at = COALESCE(?, last_interaction_at), updated_at = ?
           WHERE id = 1 AND EXISTS (
             SELECT 1 FROM heartbeat_runs
             WHERE id = ? AND status = 'completed' AND commit_token = ?
           )`,
        )
        .bind(
          input.nextWakeAt,
          input.skipReason,
          interaction,
          nowIso,
          input.runId,
          commitToken,
        ),
      this.db
        .prepare(
          `UPDATE wake_events SET status = 'completed', completed_at = ?
           WHERE id = (SELECT wake_event_id FROM heartbeat_runs WHERE id = ?)
             AND status = 'claimed' AND EXISTS (
               SELECT 1 FROM heartbeat_runs
               WHERE id = ? AND status = 'completed' AND commit_token = ?
             )`,
        )
        .bind(nowIso, input.runId, input.runId, commitToken),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_outbox
            (id, run_id, idempotency_key, mode, title, body, target_url, status,
             available_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ? IS NOT NULL AND EXISTS (
             SELECT 1 FROM heartbeat_runs
             WHERE id = ? AND status = 'completed' AND commit_token = ?
           )`,
        )
        .bind(
          input.outboxId,
          input.runId,
          input.idempotencyKey,
          input.outboxMode,
          input.notificationTitle,
          input.notificationBody,
          input.notificationTargetUrl,
          input.outboxStatus,
          nowIso,
          nowIso,
          nowIso,
          input.outboxStatus,
          input.runId,
          commitToken,
        ),
      this.db
        .prepare(
          `UPDATE heartbeat_state SET awaiting_response_since = NULL
           WHERE id = 1 AND ? IS NOT NULL AND awaiting_response_since <= ?
             AND EXISTS (
               SELECT 1 FROM heartbeat_runs
               WHERE id = ? AND status = 'completed' AND commit_token = ?
             )`,
        )
        .bind(interaction, interaction, input.runId, commitToken),
      this.db
        .prepare(
          `INSERT INTO audit_log (id, at, actor, action, outcome, subject_id, details_json)
           SELECT ?, ?, 'official-chatgpt', 'heartbeat.complete', 'ok', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM heartbeat_runs
             WHERE id = ? AND status = 'completed' AND commit_token = ?
           )`,
        )
        .bind(
          randomId("audit"),
          nowIso,
          input.runId,
          JSON.stringify({
            decision: input.decision,
            skipReason: input.skipReason,
            nextWakeAt: input.nextWakeAt,
            notificationStatus: input.outboxStatus,
          }),
          input.runId,
          commitToken,
        ),
    ]);
    return { committed: (results[0]?.meta.changes ?? 0) === 1 };
  }

  async recoverAbandonedNotificationLeases(now: Date): Promise<number> {
    const nowIso = iso(now);
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO audit_log (id, at, actor, action, outcome, subject_id, details_json)
           SELECT 'audit_' || lower(hex(randomblob(16))), ?, 'scheduler',
                  'notification.uncertain', 'warning', id, ?
           FROM notification_outbox
           WHERE status = 'sending' AND lease_expires_at < ?`,
        )
        .bind(
          nowIso,
          JSON.stringify({ reason: "dispatch_lease_expired_after_unknown_handoff" }),
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE notification_outbox
           SET status = 'uncertain', lease_expires_at = NULL, lease_token = NULL,
               provider_message = 'dispatch_lease_expired_after_unknown_handoff',
               updated_at = ?
           WHERE status = 'sending' AND lease_expires_at < ?`,
        )
        .bind(nowIso, nowIso),
    ]);
    return results[1]?.meta.changes ?? 0;
  }

  async claimNotification(
    now: Date,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<NotificationOutboxItem | null> {
    const nowIso = iso(now);
    const leaseExpiresAt = iso(new Date(now.getTime() + leaseSeconds * 1000));
    const leaseToken = randomId("lease");
    const row = await this.db
      .prepare(
        `UPDATE notification_outbox
         SET status = 'sending', attempts = attempts + 1, last_attempt_at = ?,
             lease_expires_at = ?, lease_token = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM notification_outbox
           WHERE status = 'pending' AND available_at <= ? AND attempts < ?
           ORDER BY created_at ASC LIMIT 1
         ) RETURNING *`,
      )
      .bind(nowIso, leaseExpiresAt, leaseToken, nowIso, nowIso, maxAttempts)
      .first<{
        id: string;
        run_id: string;
        idempotency_key: string;
        mode: "dry-run" | "live";
        title: string;
        body: string;
        target_url: string | null;
        status: "sending";
        attempts: number;
        lease_token: string;
      }>();
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          idempotencyKey: row.idempotency_key,
          mode: row.mode,
          title: row.title,
          body: row.body,
          targetUrl: row.target_url,
          status: row.status,
          attempts: row.attempts,
          leaseToken: row.lease_token,
        }
      : null;
  }

  async finishNotification(input: {
    item: NotificationOutboxItem;
    status: "sent" | "simulated" | "blocked";
    now: Date;
    providerStatus: number | null;
    providerMessage: string | null;
  }): Promise<boolean> {
    const nowIso = iso(input.now);
    const deliveryStatus = input.status;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE notification_outbox
           SET status = ?, provider_status = ?, provider_message = ?,
               sent_at = CASE WHEN ? IN ('sent', 'simulated') THEN ? ELSE sent_at END,
               lease_expires_at = NULL, lease_token = NULL, updated_at = ?
           WHERE id = ? AND status = 'sending' AND lease_token = ?`,
        )
        .bind(
          input.status,
          input.providerStatus,
          input.providerMessage,
          input.status,
          nowIso,
          nowIso,
          input.item.id,
          input.item.leaseToken,
        ),
      this.db
        .prepare(
          `INSERT INTO bark_deliveries
            (id, run_id, idempotency_key, mode, title, body, target_url, status,
             provider_status, provider_message, created_at, sent_at)
           SELECT id, run_id, idempotency_key, mode, title, body, target_url, ?,
                  ?, ?, created_at,
                  CASE WHEN ? IN ('sent', 'simulated') THEN ? ELSE NULL END
           FROM notification_outbox
           WHERE id = ? AND status = ? AND updated_at = ?
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             provider_status = excluded.provider_status,
             provider_message = excluded.provider_message,
             sent_at = excluded.sent_at`,
        )
        .bind(
          deliveryStatus,
          input.providerStatus,
          input.providerMessage,
          input.status,
          nowIso,
          input.item.id,
          input.status,
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE heartbeat_state
           SET last_bark_at = ?, last_bark_event_id = ?, awaiting_response_since = ?,
               last_error = NULL, updated_at = ?
           WHERE id = 1 AND ? = 'sent' AND EXISTS (
             SELECT 1 FROM notification_outbox
             WHERE id = ? AND status = 'sent' AND updated_at = ?
           )`,
        )
        .bind(
          nowIso,
          input.item.id,
          nowIso,
          nowIso,
          input.status,
          input.item.id,
          nowIso,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_log (id, at, actor, action, outcome, subject_id, details_json)
           SELECT ?, ?, 'scheduler', 'notification.finish', ?, id, ?
           FROM notification_outbox
           WHERE id = ? AND status = ? AND updated_at = ?`,
        )
        .bind(
          randomId("audit"),
          nowIso,
          input.status === "blocked" ? "blocked" : "ok",
          JSON.stringify({
            status: input.status,
            attempt: input.item.attempts,
            providerStatus: input.providerStatus,
          }),
          input.item.id,
          input.status,
          nowIso,
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async retryNotification(input: {
    item: NotificationOutboxItem;
    now: Date;
    maxAttempts: number;
    retryAt: Date;
    providerStatus: number | null;
    providerMessage: string | null;
  }): Promise<"pending" | "failed" | "stale"> {
    const nowIso = iso(input.now);
    const nextStatus = input.item.attempts >= input.maxAttempts ? "failed" : "pending";
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE notification_outbox
           SET status = ?, available_at = ?, provider_status = ?, provider_message = ?,
               lease_expires_at = NULL, lease_token = NULL, updated_at = ?
           WHERE id = ? AND status = 'sending' AND lease_token = ?`,
        )
        .bind(
          nextStatus,
          iso(input.retryAt),
          input.providerStatus,
          input.providerMessage,
          nowIso,
          input.item.id,
          input.item.leaseToken,
        ),
      this.db
        .prepare(
          `INSERT INTO bark_deliveries
            (id, run_id, idempotency_key, mode, title, body, target_url, status,
             provider_status, provider_message, created_at, sent_at)
           SELECT id, run_id, idempotency_key, mode, title, body, target_url, 'failed',
                  ?, ?, created_at, NULL
           FROM notification_outbox WHERE id = ? AND status = ? AND updated_at = ?
           ON CONFLICT(id) DO UPDATE SET status = 'failed',
             provider_status = excluded.provider_status,
             provider_message = excluded.provider_message`,
        )
        .bind(
          input.providerStatus,
          input.providerMessage,
          input.item.id,
          nextStatus,
          nowIso,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_log (id, at, actor, action, outcome, subject_id, details_json)
           SELECT ?, ?, 'scheduler', 'notification.retry', ?, id, ?
           FROM notification_outbox WHERE id = ? AND status = ? AND updated_at = ?`,
        )
        .bind(
          randomId("audit"),
          nowIso,
          nextStatus === "pending" ? "retry_scheduled" : "failed",
          JSON.stringify({
            attempt: input.item.attempts,
            nextStatus,
            retryAt: iso(input.retryAt),
            providerStatus: input.providerStatus,
          }),
          input.item.id,
          nextStatus,
          nowIso,
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1 ? nextStatus : "stale";
  }

  async markNotificationUncertain(
    item: NotificationOutboxItem,
    now: Date,
    error: string,
  ): Promise<boolean> {
    const nowIso = iso(now);
    const safeError = error.slice(0, 500);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE notification_outbox
           SET status = 'uncertain', provider_message = ?, lease_expires_at = NULL,
               lease_token = NULL, updated_at = ?
           WHERE id = ? AND status = 'sending' AND lease_token = ?`,
        )
        .bind(safeError, nowIso, item.id, item.leaseToken),
      this.db
        .prepare(
          `INSERT INTO audit_log (id, at, actor, action, outcome, subject_id, details_json)
           SELECT ?, ?, 'scheduler', 'notification.uncertain', 'warning', id, ?
           FROM notification_outbox
           WHERE id = ? AND status = 'uncertain' AND updated_at = ?`,
        )
        .bind(
          randomId("audit"),
          nowIso,
          JSON.stringify({ reason: "provider_result_unknown", error: safeError }),
          item.id,
          nowIso,
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async notificationForRun(runId: string): Promise<Record<string, unknown> | null> {
    return this.db
      .prepare("SELECT * FROM notification_outbox WHERE run_id = ?")
      .bind(runId)
      .first<Record<string, unknown>>();
  }

  async recordInteraction(at: Date, source: string): Promise<void> {
    const atIso = iso(at);
    await this.db
      .prepare(
        `UPDATE heartbeat_state
         SET last_interaction_at = ?, awaiting_response_since = NULL, updated_at = ?
         WHERE id = 1`,
      )
      .bind(atIso, atIso)
      .run();
    await this.audit(at, source, "interaction.record", "ok", null, {});
  }

  async setControl(
    now: Date,
    control: "heartbeat" | "push" | "life-events",
    enabled: boolean,
    actor: string,
  ): Promise<void> {
    const column =
      control === "heartbeat"
        ? "heartbeat_enabled"
        : control === "push"
          ? "push_enabled"
          : "life_events_enabled";
    const nowIso = iso(now);
    await this.db.batch([
      this.db
        .prepare(`UPDATE heartbeat_state SET ${column} = ?, updated_at = ? WHERE id = 1`)
        .bind(enabled ? 1 : 0, nowIso),
      ...(control === "life-events" && !enabled
        ? [
            this.db
              .prepare(
                `UPDATE source_grants SET enabled = 0, revoked_at = ?, updated_at = ?
                 WHERE source = 'life-events'`,
              )
              .bind(nowIso, nowIso),
          ]
        : []),
    ]);
    await this.audit(now, actor, `control.${control}`, "ok", null, { enabled });
  }

  async setInitialNextWake(now: Date, nextWakeAt: string, actor: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE heartbeat_state SET next_wake_at = ?, updated_at = ? WHERE id = 1`,
      )
      .bind(nextWakeAt, iso(now))
      .run();
    await this.audit(now, actor, "schedule.initialize", "ok", null, { nextWakeAt });
  }

  async setError(now: Date, message: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE heartbeat_state SET last_error = ?, updated_at = ? WHERE id = 1",
      )
      .bind(message.slice(0, 1000), iso(now))
      .run();
  }

  async audit(
    at: Date,
    actor: string,
    action: string,
    outcome: string,
    subjectId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_log (id, at, actor, action, outcome, subject_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        randomId("audit"),
        iso(at),
        actor,
        action,
        outcome,
        subjectId,
        JSON.stringify(details),
      )
      .run();
  }

  async recentAudit(limit = 20): Promise<Record<string, unknown>[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const result = await this.db
      .prepare(
        `SELECT at, actor, action, outcome, subject_id, details_json
         FROM audit_log ORDER BY at DESC LIMIT ?`,
      )
      .bind(safeLimit)
      .all<{
        at: string;
        actor: string;
        action: string;
        outcome: string;
        subject_id: string | null;
        details_json: string;
      }>();
    return result.results.map((row) => ({
      at: row.at,
      actor: row.actor,
      action: row.action,
      outcome: row.outcome,
      subjectId: row.subject_id,
      details: JSON.parse(row.details_json) as unknown,
    }));
  }
}

function mapWake(row: WakeRow): WakeEvent {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    reason: row.reason,
    visibleText: row.visible_text,
    modelContext: row.model_context,
    status: row.status,
    createdAt: row.created_at,
    eligibleUntil: row.eligible_until,
    attempts: row.attempts,
  };
}
