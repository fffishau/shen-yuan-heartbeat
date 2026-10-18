import { sendBark } from "./bark.js";
import { randomId } from "./crypto.js";
import { readLifeEvents } from "./life-events.js";
import { evaluatePushPolicy, validateNextWakeAt } from "./policy.js";
import { Repository } from "./repository.js";
import { addMinutes, iso, localDay, parseIso } from "./time.js";
import type {
  DecisionInput,
  Env,
  HeartbeatConfig,
  HeartbeatState,
  HeartbeatStatus,
} from "./types.js";

export class HeartbeatService {
  private readonly repository: Repository;

  constructor(
    private readonly env: Env,
    private readonly config: HeartbeatConfig,
  ) {
    this.repository = new Repository(env.DB);
  }

  async status(now = new Date()): Promise<HeartbeatStatus> {
    const day = localDay(now, this.config.timezone);
    const [state, usage] = await Promise.all([
      this.repository.state(),
      this.repository.usage(day),
    ]);
    return {
      state,
      usageToday: {
        day,
        schedulerTicks: usage.scheduler_ticks,
        officialWakes: usage.official_wakes,
        mcpCalls: usage.mcp_calls,
        barkAttempts: usage.bark_attempts,
        barkSent: usage.bark_sent,
        lifeEventReads: usage.life_event_reads,
        d1WritesEstimate: usage.d1_writes_estimate,
      },
      deliveryMode: this.config.barkMode,
      officialWakePath: {
        automation: "available-hourly-only",
        messageBridge: "opportunistic-while-view-active",
        genericExternalWebhook: "unavailable",
      },
      estimatedCostUsd: null,
      costNote:
        "Cloudflare and ChatGPT subscription pricing are not inferable at runtime; usage counters are reported for external calculation.",
    };
  }

  async schedulerTick(now = new Date()) {
    try {
      const abandonedNotifications = await this.repository.recoverAbandonedNotificationLeases(now);
      const tick = await this.repository.schedulerTick(now, this.config);
      const notification = await this.dispatchNextNotification(now);
      return { ...tick, abandonedNotifications, notification };
    } catch (error) {
      await this.repository.setError(now, message(error));
      throw error;
    }
  }

  async beginOfficialCycle(input: {
    source: "chatgpt-automation" | "message-bridge" | "manual-test";
    eventId?: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const started = await this.repository.beginRun(
      now,
      this.config,
      input.source,
      input.eventId,
    );
    const since = started.state.lastOfficialWakeAt ?? iso(new Date(now.getTime() - 86_400_000));
    const lifeEvents = await readLifeEvents(
      this.env,
      started.state.lifeEventsEnabled,
      since,
    );
    if (started.state.lifeEventsEnabled) {
      await this.repository.incrementUsage(
        localDay(now, this.config.timezone),
        "life_event_reads",
      );
    }
    return {
      ...started,
      lifeEvents,
      instruction: [
        "Warmup must already have been read in this official ChatGPT turn.",
        "Choose silence unless there is a genuine reason to contact Han.",
        `Choose nextWakeAt ${this.config.minWakeMinutes}-${this.config.maxWakeMinutes} minutes from now based on context, not randomness.`,
        "Call heartbeat_commit_decision exactly once with the stable runId.",
      ],
    };
  }

  async commitDecision(input: DecisionInput, now = new Date()) {
    validateNextWakeAt(now, input.nextWakeAt, this.config);
    const previousCommit = await this.repository.runByIdempotencyKey(
      input.idempotencyKey,
    );
    if (previousCommit) {
      if (previousCommit.id !== input.runId) {
        throw new Error("idempotencyKey is already used by another heartbeat run.");
      }
      return {
        idempotentReplay: true,
        effectiveAction: previousCommit.decision,
        skipReason: previousCommit.skipReason,
        nextWakeAt: previousCommit.nextWakeAt,
        delivery: await this.repository.notificationForRun(previousCommit.id),
      };
    }
    const run = await this.repository.run(input.runId);
    if (!run) throw new Error("Unknown heartbeat runId.");
    if (run.status === "expired") {
      throw new Error("Heartbeat run lease expired; the decision was not accepted.");
    }
    if (run.status !== "started") {
      return {
        idempotentReplay: true,
        effectiveAction: run.decision,
        skipReason: run.skipReason,
        nextWakeAt: run.nextWakeAt,
        delivery: await this.repository.notificationForRun(run.id),
      };
    }
    const leaseExpiresAt = parseIso(run.leaseExpiresAt);
    if (!leaseExpiresAt || leaseExpiresAt.getTime() < now.getTime()) {
      throw new Error("Heartbeat run lease expired; wait for scheduler recovery.");
    }

    let state = await this.repository.state();
    if (input.observedInteractionAt) {
      const observed = new Date(input.observedInteractionAt);
      if (Number.isNaN(observed.getTime())) {
        throw new Error("observedInteractionAt must be a valid ISO-8601 timestamp.");
      }
      state = {
        ...state,
        lastInteractionAt: observed.toISOString(),
        awaitingResponseSince:
          state.awaitingResponseSince &&
          observed.getTime() >= new Date(state.awaitingResponseSince).getTime()
            ? null
            : state.awaitingResponseSince,
      };
    }

    let effectiveAction: "silent" | "notify" = input.action;
    let skipReason = input.skipReason ?? null;
    let outboxStatus: "pending" | "blocked" | null = null;
    let notificationBody: string | null = null;
    const outboxId = input.action === "notify" ? randomId("notification") : null;

    if (input.action === "notify") {
      const body = input.message?.trim() ?? "";
      if (!body) throw new Error("message is required when action=notify.");
      if (body.length > 500) throw new Error("Bark message must be 500 characters or fewer.");
      const pushesToday = await this.repository.pushesToday(
        localDay(now, this.config.timezone),
      );
      const policy = evaluatePushPolicy({
        now,
        state,
        config: this.config,
        pushesToday,
      });
      notificationBody = body;
      if (!policy.allowed) {
        effectiveAction = "silent";
        skipReason = policy.reason;
        outboxStatus = "blocked";
      } else {
        outboxStatus = "pending";
      }
    } else if (!skipReason) {
      skipReason = "official_decision_silent";
    }

    const committed = await this.repository.commitRun({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      now,
      decision: effectiveAction,
      reason: input.reason,
      skipReason,
      nextWakeAt: new Date(input.nextWakeAt).toISOString(),
      outboxId,
      outboxStatus,
      outboxMode: this.config.barkMode,
      notificationTitle: notificationBody ? "沉淵" : null,
      notificationBody,
      notificationTargetUrl: this.env.CHATGPT_CONVERSATION_URL ?? null,
      ...(input.observedInteractionAt
        ? { observedInteractionAt: input.observedInteractionAt }
        : {}),
    });
    if (!committed.committed) {
      const current = await this.repository.run(input.runId);
      if (!current || current.status === "expired") {
        throw new Error("Heartbeat run expired before the decision was committed.");
      }
      if (current.status === "completed" && current.idempotencyKey === input.idempotencyKey) {
        return {
          idempotentReplay: true,
          effectiveAction: current.decision,
          skipReason: current.skipReason,
          nextWakeAt: current.nextWakeAt,
          delivery: await this.repository.notificationForRun(current.id),
        };
      }
      throw new Error("Heartbeat decision conflicted with another commit.");
    }
    return {
      idempotentReplay: false,
      effectiveAction,
      skipReason,
      nextWakeAt: new Date(input.nextWakeAt).toISOString(),
      delivery: outboxId
        ? { id: outboxId, status: outboxStatus, mode: this.config.barkMode }
        : undefined,
    };
  }

  private async dispatchNextNotification(now: Date) {
    const item = await this.repository.claimNotification(
      now,
      this.config.reservationLeaseSeconds,
      this.config.notificationMaxAttempts,
    );
    if (!item) return null;

    const [state, pushesToday] = await Promise.all([
      this.repository.state(),
      this.repository.pushesToday(localDay(now, this.config.timezone)),
    ]);
    const policy = evaluatePushPolicy({ now, state, config: this.config, pushesToday });
    if (!policy.allowed) {
      await this.repository.finishNotification({
        item,
        status: "blocked",
        now,
        providerStatus: null,
        providerMessage: policy.reason,
      });
      return { id: item.id, status: "blocked", reason: policy.reason };
    }

    await this.repository.incrementUsage(
      localDay(now, this.config.timezone),
      "bark_attempts",
    );

    try {
      // A notification committed while dry-run was active must never become live
      // merely because the runtime setting changed before the next Cron tick.
      const effectiveMode =
        item.mode === "live" && this.config.barkMode === "live" ? "live" : "dry-run";
      const result = await sendBark({
        env: this.env,
        config: { ...this.config, barkMode: effectiveMode },
        title: item.title,
        body: item.body,
      });
      if (result.status === "sent" || result.status === "simulated") {
        await this.repository.finishNotification({
          item,
          status: result.status,
          now,
          providerStatus: result.providerStatus,
          providerMessage: result.providerMessage,
        });
        if (result.status === "sent") {
          await this.repository.incrementUsage(
            localDay(now, this.config.timezone),
            "bark_sent",
          );
        }
        return { id: item.id, status: result.status };
      }

      const retryAt = addMinutes(
        now,
        this.config.notificationRetryMinutes * item.attempts,
      );
      const status = await this.repository.retryNotification({
        item,
        now,
        maxAttempts: this.config.notificationMaxAttempts,
        retryAt,
        providerStatus: result.providerStatus,
        providerMessage: result.providerMessage,
      });
      await this.repository.setError(
        now,
        result.providerMessage ?? "Bark delivery failed.",
      );
      return { id: item.id, status, retryAt: iso(retryAt) };
    } catch (error) {
      const detail = message(error);
      await this.repository.markNotificationUncertain(item, now, detail);
      await this.repository.setError(now, `Bark result unknown: ${detail}`);
      return { id: item.id, status: "uncertain" };
    }
  }

  async control(
    control: "heartbeat" | "push" | "life-events",
    enabled: boolean,
    actor: string,
    now = new Date(),
  ) {
    await this.repository.setControl(now, control, enabled, actor);
    return this.status(now);
  }

  async initializeSchedule(nextWakeAt: string, actor: string, now = new Date()) {
    const parsed = validateNextWakeAt(now, nextWakeAt, this.config);
    await this.repository.setInitialNextWake(now, parsed.toISOString(), actor);
    return this.status(now);
  }

  async recordInteraction(at: string, source: string) {
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) throw new Error("Invalid interaction timestamp.");
    await this.repository.recordInteraction(parsed, source);
    return this.status(parsed);
  }

  async audit(limit: number) {
    return this.repository.recentAudit(limit);
  }

  bridgeRepository(): Repository {
    return this.repository;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withObservedInteraction(
  state: HeartbeatState,
  at: string | undefined,
): HeartbeatState {
  if (!at) return state;
  return { ...state, lastInteractionAt: at };
}
