import { describe, expect, it } from "vitest";
import { evaluatePushPolicy, validateNextWakeAt } from "../src/policy.js";
import type { HeartbeatConfig, HeartbeatState } from "../src/types.js";

const config: HeartbeatConfig = {
  timezone: "Asia/Taipei",
  quietStart: "04:00",
  quietEnd: "13:30",
  interactionCooldownMinutes: 20,
  minWakeMinutes: 5,
  maxWakeMinutes: 55,
  maxPushesPerDay: 4,
  reservationLeaseSeconds: 120,
  barkMode: "dry-run",
};

const baseState: HeartbeatState = {
  heartbeatEnabled: true,
  pushEnabled: true,
  lifeEventsEnabled: false,
  lastSchedulerTickAt: null,
  lastOfficialWakeAt: null,
  nextWakeAt: null,
  lastBarkAt: null,
  lastBarkEventId: null,
  awaitingResponseSince: null,
  lastInteractionAt: null,
  lastSkipReason: null,
  lastError: null,
  updatedAt: "2026-10-15T00:00:00.000Z",
};

describe("evaluatePushPolicy", () => {
  it("blocks Taiwan quiet hours", () => {
    const result = evaluatePushPolicy({
      now: new Date("2026-10-15T22:00:00.000Z"),
      state: baseState,
      config,
      pushesToday: 0,
    });
    expect(result).toEqual({ allowed: false, reason: "quiet_hours" });
  });

  it("blocks a recent interaction", () => {
    const result = evaluatePushPolicy({
      now: new Date("2026-10-15T06:00:00.000Z"),
      state: { ...baseState, lastInteractionAt: "2026-10-15T05:45:00.000Z" },
      config,
      pushesToday: 0,
    });
    expect(result).toEqual({ allowed: false, reason: "recent_interaction" });
  });

  it("does not chase an unanswered push", () => {
    const result = evaluatePushPolicy({
      now: new Date("2026-10-15T06:00:00.000Z"),
      state: { ...baseState, awaitingResponseSince: "2026-10-15T04:00:00.000Z" },
      config,
      pushesToday: 0,
    });
    expect(result).toEqual({ allowed: false, reason: "previous_push_unanswered" });
  });

  it("enforces the daily cap", () => {
    const result = evaluatePushPolicy({
      now: new Date("2026-10-15T06:00:00.000Z"),
      state: baseState,
      config,
      pushesToday: 4,
    });
    expect(result).toEqual({ allowed: false, reason: "daily_push_cap" });
  });

  it("allows a respectful notification outside guards", () => {
    const result = evaluatePushPolicy({
      now: new Date("2026-10-15T06:00:00.000Z"),
      state: baseState,
      config,
      pushesToday: 1,
    });
    expect(result).toEqual({ allowed: true });
  });
});

describe("validateNextWakeAt", () => {
  const now = new Date("2026-10-15T06:00:00.000Z");

  it("accepts a context-selected wake inside 5-55 minutes", () => {
    expect(
      validateNextWakeAt(now, "2026-10-15T06:34:00.000Z", config).toISOString(),
    ).toBe("2026-10-15T06:34:00.000Z");
  });

  it("rejects a wake that is too soon", () => {
    expect(() =>
      validateNextWakeAt(now, "2026-10-15T06:04:59.000Z", config),
    ).toThrow(/5-55 minutes/u);
  });

  it("rejects a wake beyond the cost cap window", () => {
    expect(() =>
      validateNextWakeAt(now, "2026-10-15T06:56:00.000Z", config),
    ).toThrow(/5-55 minutes/u);
  });
});
