import type { Env, HeartbeatConfig } from "./types.js";

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: Env): HeartbeatConfig {
  return {
    timezone: env.TIMEZONE || "Asia/Taipei",
    quietStart: env.QUIET_START || "04:00",
    quietEnd: env.QUIET_END || "13:30",
    interactionCooldownMinutes: integer(env.INTERACTION_COOLDOWN_MINUTES, 20),
    minWakeMinutes: integer(env.MIN_WAKE_MINUTES, 5),
    maxWakeMinutes: integer(env.MAX_WAKE_MINUTES, 55),
    maxPushesPerDay: integer(env.MAX_PUSHES_PER_DAY, 4),
    reservationLeaseSeconds: integer(env.RESERVATION_LEASE_SECONDS, 120),
    barkMode: env.BARK_MODE === "live" ? "live" : "dry-run",
  };
}
