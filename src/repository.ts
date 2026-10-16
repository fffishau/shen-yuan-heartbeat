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
  ): Promise<{ event: WakeEvent | null; reason: string }> {
    const nowIso = iso(now);
    const day = localDay(now, config.timezone);
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
    ]);

    const state = await this.state();
    if (!state.heartbeatEnabled) return { event: null, reason: "heartbeat_paused" };
    const next = parseIso(state.nextWakeAt);
    if (!next) return { event: null, reason: "next_wake_not_set" };
    if (next.getTime() > now.getTime()) return { event: null, reason: "not_due" };

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
    return { event, reason: event?.status === "pending" ? "wake_enqueued" : "wake_exists" };
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
    let event: WakeEvent | null = null;
    if (eventId) {
      await this.db
        .prepare(
          `UPDATE wake_events SET status = 'claimed', claimed_at = ?
           WHERE id = ? AND status IN ('pending', 'reserved', 'host_sent', 'claimed')`,
        )
        .bind(nowIso, eventId)
        .run();
      event = await this.wakeEvent(eventId);
    } else {
      const row = await this.db
        .prepare(
          `UPDATE wake_events SET status = 'claimed', claimed_at = ?
           WHERE id = (
             SELECT id FROM wake_events
             WHERE status IN ('pending', 'host_sent') AND eligible_until >= ?
             ORDER BY created_at ASC LIMIT 1
           ) RETURNING *`,
        )
        .bind(nowIso, nowIso)
        .first<WakeRow>();
      event = row ? mapWake(row) : null;
    }
    const runId = randomId("run");
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO heartbeat_runs (id, wake_event_id, source, status, started_at)
           VALUES (?, ?, ?, 'started', ?)`,
        )
        .bind(runId, event?.id ?? null, source, nowIso),
      this.db
        .prepare(
          `UPDATE heartbeat_state
           SET last_official_wake_at = ?, last_error = NULL, updated_at = ?
           WHERE id = 1`,
        )
        .bind(nowIso, nowIso),
      this.db
        .prepare(
          `INSERT INTO usage_daily (day, official_wakes, mcp_calls, d1_writes_estimate)
           VALUES (?, 1, 1, 3)
           ON CONFLICT(day) DO UPDATE SET
             official_wakes = official_wakes + 1,
             mcp_calls = mcp_calls + 1,
             d1_writes_estimate = d1_writes_estimate + 3`,
        )
        .bind(localDay(now, config.timezone)),
    ]);
    await this.audit(now, source, "heartbeat.begin", "ok", runId, {
      eventId: event?.id ?? null,
    });
    return { runId, event, state: await this.state() };
  }

  async pushesToday(day: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT bark_sent FROM usage_daily WHERE day = ?")
      .bind(day)
      .first<{ bark_sent: number }>();
    return row?.bark_sent ?? 0;
  }

  async existingDelivery(idempotencyKey: string): Promise<{
    id: string;
    status: string;
    mode: string;
  } | null> {
    return this.db
      .prepare(
        "SELECT id, status, mode FROM bark_deliveries WHERE idempotency_key = ?",
      )
      .bind(idempotencyKey)
      .first<{ id: string; status: string; mode: string }>();
  }

  async run(runId: string): Promise<{
    id: string;
    status: "started" | "completed" | "failed";
    idempotencyKey: string | null;
    decision: string | null;
    skipReason: string | null;
    nextWakeAt: string | null;
    barkEventId: string | null;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, status, idempotency_key, decision, skip_reason,
                next_wake_at, bark_event_id
         FROM heartbeat_runs WHERE id = ?`,
      )
      .bind(runId)
      .first<{
        id: string;
        status: "started" | "completed" | "failed";
        idempotency_key: string | null;
        decision: string | null;
        skip_reason: string | null;
        next_wake_at: string | null;
        bark_event_id: string | null;
      }>();
    return row
      ? {
          id: row.id,
          status: row.status,
          idempotencyKey: row.idempotency_key,
          decision: row.decision,
          skipReason: row.skip_reason,
          nextWakeAt: row.next_wake_at,
          barkEventId: row.bark_event_id,
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

  async recordDelivery(input: {
    id: string;
    runId: string;
    idempotencyKey: string;
    mode: "dry-run" | "live";
    title: string;
    body: string;
    targetUrl: string | null;
    status: "simulated" | "sent" | "failed" | "blocked";
    providerStatus: number | null;
    providerMessage: string | null;
    now: Date;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO bark_deliveries
          (id, run_id, idempotency_key, mode, title, body, target_url, status,
           provider_status, provider_message, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.runId,
        input.idempotencyKey,
        input.mode,
        input.title,
        input.body,
        input.targetUrl,
        input.status,
        input.providerStatus,
        input.providerMessage,
        iso(input.now),
        input.status === "sent" || input.status === "simulated"
          ? iso(input.now)
          : null,
      )
      .run();
  }

  async completeRun(input: {
    runId: string;
    idempotencyKey: string;
    now: Date;
    decision: "silent" | "notify";
    reason: string;
    skipReason: string | null;
    nextWakeAt: string;
    barkEventId: string | null;
    observedInteractionAt?: string;
  }): Promise<void> {
    const nowIso = iso(input.now);
    const interaction = input.observedInteractionAt
      ? parseIso(input.observedInteractionAt)?.toISOString()
      : null;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE heartbeat_runs
           SET status = 'completed', completed_at = ?, idempotency_key = ?, decision = ?,
               decision_reason = ?, skip_reason = ?, next_wake_at = ?, bark_event_id = ?
           WHERE id = ? AND status = 'started'`,
        )
        .bind(
          nowIso,
          input.idempotencyKey,
          input.decision,
          input.reason,
          input.skipReason,
          input.nextWakeAt,
          input.barkEventId,
          input.runId,
        ),
      this.db
        .prepare(
          `UPDATE heartbeat_state SET
             next_wake_at = ?,
             last_skip_reason = ?,
             last_bark_at = CASE WHEN ? IS NULL THEN last_bark_at ELSE ? END,
             last_bark_event_id = CASE WHEN ? IS NULL THEN last_bark_event_id ELSE ? END,
             awaiting_response_since = CASE
               WHEN ? IS NULL THEN awaiting_response_since ELSE ? END,
             last_interaction_at = COALESCE(?, last_interaction_at),
             updated_at = ?
           WHERE id = 1`,
        )
        .bind(
          input.nextWakeAt,
          input.skipReason,
          input.barkEventId,
          nowIso,
          input.barkEventId,
          input.barkEventId,
          input.barkEventId,
          nowIso,
          interaction,
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE wake_events SET status = 'completed', completed_at = ?
           WHERE id = (SELECT wake_event_id FROM heartbeat_runs WHERE id = ?)
             AND status = 'claimed'`,
        )
        .bind(nowIso, input.runId),
    ];
    if (interaction) {
      statements.push(
        this.db
          .prepare(
            `UPDATE heartbeat_state SET awaiting_response_since = NULL
             WHERE id = 1 AND awaiting_response_since <= ?`,
          )
          .bind(interaction),
      );
    }
    await this.db.batch(statements);
    await this.audit(input.now, "official-chatgpt", "heartbeat.complete", "ok", input.runId, {
      decision: input.decision,
      skipReason: input.skipReason,
      nextWakeAt: input.nextWakeAt,
    });
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
