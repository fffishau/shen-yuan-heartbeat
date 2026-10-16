import { isInsideWindow, parseIso } from "./time.js";
import type {
  HeartbeatConfig,
  HeartbeatState,
  PushPolicyResult,
} from "./types.js";

export function validateNextWakeAt(
  now: Date,
  nextWakeAt: string,
  config: HeartbeatConfig,
): Date {
  const next = parseIso(nextWakeAt);
  if (!next) throw new Error("nextWakeAt must be a valid ISO-8601 timestamp.");
  const minutes = (next.getTime() - now.getTime()) / 60_000;
  if (minutes < config.minWakeMinutes || minutes > config.maxWakeMinutes) {
    throw new Error(
      `nextWakeAt must be ${config.minWakeMinutes}-${config.maxWakeMinutes} minutes after the decision.`,
    );
  }
  return next;
}

export function evaluatePushPolicy(input: {
  now: Date;
  state: HeartbeatState;
  config: HeartbeatConfig;
  pushesToday: number;
}): PushPolicyResult {
  const { now, state, config, pushesToday } = input;
  if (!state.heartbeatEnabled) return { allowed: false, reason: "heartbeat_paused" };
  if (!state.pushEnabled) return { allowed: false, reason: "push_paused" };
  if (
    isInsideWindow(now, config.timezone, config.quietStart, config.quietEnd)
  ) {
    return { allowed: false, reason: "quiet_hours" };
  }
  const lastInteraction = parseIso(state.lastInteractionAt);
  if (
    lastInteraction &&
    now.getTime() - lastInteraction.getTime() <
      config.interactionCooldownMinutes * 60_000
  ) {
    return { allowed: false, reason: "recent_interaction" };
  }
  if (state.awaitingResponseSince) {
    return { allowed: false, reason: "previous_push_unanswered" };
  }
  if (pushesToday >= config.maxPushesPerDay) {
    return { allowed: false, reason: "daily_push_cap" };
  }
  return { allowed: true };
}
