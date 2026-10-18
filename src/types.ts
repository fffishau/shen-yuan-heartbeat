export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  MCP_CONNECT_PASSPHRASE?: string;
  BARK_DEVICE_KEY?: string;
  BARK_MODE?: string;
  BARK_SERVER_URL?: string;
  CHATGPT_CONVERSATION_URL?: string;
  LIFE_EVENTS_BASE_URL?: string;
  LIFE_EVENTS_READ_TOKEN?: string;
  PLUGIN_ROUTE_HINT?: string;
  TIMEZONE?: string;
  QUIET_START?: string;
  QUIET_END?: string;
  INTERACTION_COOLDOWN_MINUTES?: string;
  MIN_WAKE_MINUTES?: string;
  MAX_WAKE_MINUTES?: string;
  MAX_PUSHES_PER_DAY?: string;
  RESERVATION_LEASE_SECONDS?: string;
  RUN_LEASE_SECONDS?: string;
  NOTIFICATION_MAX_ATTEMPTS?: string;
  NOTIFICATION_RETRY_MINUTES?: string;
}

export type HeartbeatState = {
  heartbeatEnabled: boolean;
  pushEnabled: boolean;
  lifeEventsEnabled: boolean;
  lastSchedulerTickAt: string | null;
  lastOfficialWakeAt: string | null;
  nextWakeAt: string | null;
  lastBarkAt: string | null;
  lastBarkEventId: string | null;
  awaitingResponseSince: string | null;
  lastInteractionAt: string | null;
  lastSkipReason: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type WakeEventStatus =
  | "pending"
  | "reserved"
  | "host_sent"
  | "claimed"
  | "completed"
  | "expired"
  | "failed";

export type WakeEvent = {
  id: string;
  kind: string;
  source: string;
  reason: string;
  visibleText: string;
  modelContext: string;
  status: WakeEventStatus;
  createdAt: string;
  eligibleUntil: string;
  attempts: number;
};

export type HeartbeatConfig = {
  timezone: string;
  quietStart: string;
  quietEnd: string;
  interactionCooldownMinutes: number;
  minWakeMinutes: number;
  maxWakeMinutes: number;
  maxPushesPerDay: number;
  reservationLeaseSeconds: number;
  runLeaseSeconds: number;
  notificationMaxAttempts: number;
  notificationRetryMinutes: number;
  barkMode: "dry-run" | "live";
};

export type DecisionInput = {
  runId: string;
  idempotencyKey: string;
  action: "silent" | "notify";
  reason: string;
  skipReason?: string | undefined;
  message?: string | undefined;
  nextWakeAt: string;
  observedInteractionAt?: string | undefined;
};

export type HeartbeatStatus = {
  state: HeartbeatState;
  usageToday: {
    day: string;
    schedulerTicks: number;
    officialWakes: number;
    mcpCalls: number;
    barkAttempts: number;
    barkSent: number;
    lifeEventReads: number;
    d1WritesEstimate: number;
  };
  deliveryMode: "dry-run" | "live";
  officialWakePath: {
    automation: "available-hourly-only";
    messageBridge: "opportunistic-while-view-active";
    genericExternalWebhook: "unavailable";
  };
  estimatedCostUsd: null;
  costNote: string;
};

export type PushPolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export type LifeEvent = {
  id: string;
  type: string;
  occurredAt: string;
  summary: string;
  expiresAt?: string;
  mediaReference?: string;
};
