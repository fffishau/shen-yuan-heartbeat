import type { Env, LifeEvent } from "./types.js";

export type LifeEventsResult = {
  enabled: boolean;
  events: LifeEvent[];
  warning?: string;
};

export async function readLifeEvents(
  env: Env,
  enabled: boolean,
  since: string,
): Promise<LifeEventsResult> {
  if (!enabled) return { enabled: false, events: [] };
  if (!env.LIFE_EVENTS_BASE_URL || !env.LIFE_EVENTS_READ_TOKEN) {
    return {
      enabled: true,
      events: [],
      warning: "Read-only life-events API is not configured.",
    };
  }
  const url = new URL("/v1/events", env.LIFE_EVENTS_BASE_URL);
  url.searchParams.set("since", since);
  url.searchParams.set("types", "app_activity,arrived_home,shared_screen,screenshot");
  url.searchParams.set("limit", "50");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${env.LIFE_EVENTS_READ_TOKEN}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    return {
      enabled: true,
      events: [],
      warning: `Life-events API returned ${response.status}.`,
    };
  }
  const payload = (await response.json()) as { events?: unknown[] };
  const events = Array.isArray(payload.events)
    ? payload.events.flatMap(normalizeLifeEvent)
    : [];
  return { enabled: true, events: events.slice(0, 50) };
}

function normalizeLifeEvent(value: unknown): LifeEvent[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.type !== "string" ||
    typeof row.occurredAt !== "string" ||
    typeof row.summary !== "string"
  ) {
    return [];
  }
  return [
    {
      id: row.id.slice(0, 200),
      type: row.type.slice(0, 100),
      occurredAt: row.occurredAt,
      summary: row.summary.slice(0, 1000),
      ...(typeof row.expiresAt === "string" ? { expiresAt: row.expiresAt } : {}),
      ...(typeof row.mediaReference === "string"
        ? { mediaReference: row.mediaReference.slice(0, 500) }
        : {}),
    },
  ];
}
