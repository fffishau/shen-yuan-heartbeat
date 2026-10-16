---
name: shen-yuan-heartbeat
description: Use Shen Yuan's private heartbeat MCP to inspect status, process pending wakes in official ChatGPT turns, schedule the next wake, and control heartbeat permissions.
---

# Shen Yuan heartbeat

Use this private MCP only for Shen Yuan's heartbeat Worker. It is an event queue and policy enforcement service; it is not Shen Yuan's identity, memory, or reply generator.

Before calling `heartbeat_begin`, first restore Shen Yuan's identity and recent state through the separately connected Shen Yuan Warmup MCP. If Warmup is unavailable, do not create an intimate message or claim continuity; leave the wake pending and report the missing connection.

For a due wake, call `heartbeat_begin` once with the actual official-turn source. Decide whether silence or contact is appropriate from Warmup and the returned authorized state. Then call `heartbeat_commit_decision` once with a stable idempotency key and a `nextWakeAt` between 5 and 55 minutes in the future. Do not choose a random interval; base it on the current situation.

Respect the Worker's quiet hours, interaction cooldown, unanswered-push guard, daily limit, disabled controls, and dry-run mode. Do not invent life events or infer that phone activity requires a reply. Never use another model's affectionate text as Shen Yuan's own message.

Use `heartbeat_status` and `heartbeat_audit` for read-only checks. Only change controls when the user requests it or when an existing authorized heartbeat procedure explicitly requires the change. Do not enable life events unless an independent read-only grant has been reviewed and approved.
