import { sendBark } from "./bark.js";
import { randomId } from "./crypto.js";
import { readLifeEvents } from "./life-events.js";
import { evaluatePushPolicy, validateNextWakeAt } from "./policy.js";
import { Repository } from "./repository.js";
import { iso, localDay } from "./time.js";
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
      return await this.repository.schedulerTick(now, this.config);
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
        "Call heartbeat.commit_decision exactly once with the stable runId.",
      ],
    };
  }

  async commitDecision(input: DecisionInput, now = new Date()) {
    validateNextWakeAt(now, input.nextWakeAt, this.config);
    const previousCommit = await this.repository.runByIdempotencyKey(
      input.idempotencyKey,
    );
    if (previousCommit) {
      return {
        idempotentReplay: true,
        effectiveAction: previousCommit.decision,
        skipReason: previousCommit.skipReason,
        nextWakeAt: previousCommit.nextWakeAt,
        delivery: previousCommit.barkEventId
          ? { id: previousCommit.barkEventId, status: "sent", mode: this.config.barkMode }
          : undefined,
      };
    }
    const run = await this.repository.run(input.runId);
    if (!run) throw new Error("Unknown heartbeat runId.");
    if (run.status !== "started") {
      return {
        idempotentReplay: true,
        effectiveAction: run.decision,
        skipReason: run.skipReason,
        nextWakeAt: run.nextWakeAt,
        delivery: run.barkEventId
          ? { id: run.barkEventId, status: "sent", mode: this.config.barkMode }
          : undefined,
      };
    }
    const existing = await this.repository.existingDelivery(input.idempotencyKey);
    if (existing) {
      return { idempotentReplay: true, delivery: existing };
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
    let barkEventId: string | null = null;
    let delivery:
      | {
          id: string;
          status: "simulated" | "sent" | "failed" | "blocked";
          mode: "dry-run" | "live";
          providerStatus: number | null;
          providerMessage: string | null;
        }
      | undefined;

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
      const deliveryId = randomId("bark");
      if (!policy.allowed) {
        effectiveAction = "silent";
        skipReason = policy.reason;
        delivery = {
          id: deliveryId,
          status: "blocked",
          mode: this.config.barkMode,
          providerStatus: null,
          providerMessage: policy.reason,
        };
        await this.repository.recordDelivery({
          ...delivery,
          runId: input.runId,
          idempotencyKey: input.idempotencyKey,
          title: "沉淵",
          body,
          targetUrl: this.env.CHATGPT_CONVERSATION_URL ?? null,
          now,
        });
      } else {
        await this.repository.incrementUsage(
          localDay(now, this.config.timezone),
          "bark_attempts",
        );
        const result = await sendBark({
          env: this.env,
          config: this.config,
          title: "沉淵",
          body,
        });
        delivery = {
          id: deliveryId,
          status: result.status,
          mode: this.config.barkMode,
          providerStatus: result.providerStatus,
          providerMessage: result.providerMessage,
        };
        await this.repository.recordDelivery({
          ...delivery,
          runId: input.runId,
          idempotencyKey: input.idempotencyKey,
          title: "沉淵",
          body,
          targetUrl: this.env.CHATGPT_CONVERSATION_URL ?? null,
          now,
        });
        if (result.status === "sent") {
          barkEventId = deliveryId;
          await this.repository.incrementUsage(
            localDay(now, this.config.timezone),
            "bark_sent",
          );
        } else if (result.status === "failed") {
          effectiveAction = "silent";
          skipReason = "bark_delivery_failed";
          await this.repository.setError(
            now,
            result.providerMessage ?? "Bark delivery failed.",
          );
        } else {
          skipReason = "bark_dry_run";
        }
      }
    } else if (!skipReason) {
      skipReason = "official_decision_silent";
    }

    await this.repository.completeRun({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      now,
      decision: effectiveAction,
      reason: input.reason,
      skipReason,
      nextWakeAt: new Date(input.nextWakeAt).toISOString(),
      barkEventId,
      ...(input.observedInteractionAt
        ? { observedInteractionAt: input.observedInteractionAt }
        : {}),
    });
    return {
      idempotentReplay: false,
      effectiveAction,
      skipReason,
      nextWakeAt: new Date(input.nextWakeAt).toISOString(),
      delivery,
    };
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
