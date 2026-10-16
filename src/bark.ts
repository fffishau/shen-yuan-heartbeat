import type { Env, HeartbeatConfig } from "./types.js";

export type BarkResult = {
  status: "simulated" | "sent" | "failed";
  providerStatus: number | null;
  providerMessage: string | null;
};

export async function sendBark(input: {
  env: Env;
  config: HeartbeatConfig;
  title: string;
  body: string;
}): Promise<BarkResult> {
  if (input.config.barkMode === "dry-run") {
    return {
      status: "simulated",
      providerStatus: null,
      providerMessage: "BARK_MODE=dry-run; no network request was sent.",
    };
  }
  if (!input.env.BARK_DEVICE_KEY) {
    return {
      status: "failed",
      providerStatus: null,
      providerMessage: "BARK_DEVICE_KEY is not configured.",
    };
  }
  const base = (input.env.BARK_SERVER_URL || "https://api.day.app").replace(/\/$/u, "");
  const response = await fetch(`${base}/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_key: input.env.BARK_DEVICE_KEY,
      title: input.title,
      body: input.body,
      ...(input.env.CHATGPT_CONVERSATION_URL
        ? { url: input.env.CHATGPT_CONVERSATION_URL }
        : {}),
      group: "shen-yuan",
      isArchive: "1",
    }),
  });
  const providerMessage = (await response.text()).slice(0, 500);
  return {
    status: response.ok ? "sent" : "failed",
    providerStatus: response.status,
    providerMessage,
  };
}
