import { toolTimeoutCallKey } from "./tool-timeout.ts";

export const SUPERVISOR_WAIT_TIMEOUT_MESSAGE = "Timed out waiting on supervisor.";

export function isSupervisorWaitTimeout(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const details = (result as { details?: unknown }).details;
	return !!details && typeof details === "object" && (details as { supervisorWaitTimedOut?: unknown }).supervisorWaitTimedOut === true;
}

export function isBlockingSupervisorTool(toolName: string | undefined, args: unknown): boolean {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const input = args as Record<string, unknown>;
	return toolName === "contact_supervisor"
		? input.reason === "need_decision" || input.reason === "interview_request"
		: toolName === "intercom" && input.action === "ask";
}

/** One active-runtime budget. Concurrent waits pause it once, never replenish it. */
export function createActiveRuntimeTimeout(budgetMs: number) {
	let remaining = Math.max(0, budgetMs);
	let startedAt: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onTimeout: (() => void) | undefined;
	const waits = new Set<string>();
	const consume = () => {
		if (startedAt !== undefined) remaining = Math.max(0, remaining - (Date.now() - startedAt));
		startedAt = undefined;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const arm = () => {
		if (!onTimeout || waits.size > 0 || timer !== undefined) return;
		startedAt = Date.now();
		timer = setTimeout(() => {
			consume();
			const callback = onTimeout;
			onTimeout = undefined;
			callback?.();
		}, remaining);
		timer.unref?.();
	};
	return {
		start(callback: () => void) { onTimeout = callback; arm(); },
		stop() { consume(); onTimeout = undefined; },
		setWaiting(key: string, waiting: boolean) {
			if (waiting) {
				if (waits.size === 0) consume();
				waits.add(key);
			} else {
				waits.delete(key);
				arm();
			}
		},
		remainingMs: () => Math.max(0, remaining - (startedAt === undefined ? 0 : Date.now() - startedAt)),
		deadlineAt: () => Date.now() + Math.max(0, remaining - (startedAt === undefined ? 0 : Date.now() - startedAt)),
		dispose() { consume(); onTimeout = undefined; waits.clear(); },
	};
}

export type ActiveRuntimeTimeout = ReturnType<typeof createActiveRuntimeTimeout>;

export function createSupervisorWaitTracker(onWait: (key: string, waiting: boolean) => void) {
	let sequence = 0;
	const calls = new Map<string, { tool: string; blocking: boolean }>();
	const clear = () => {
		for (const [key, call] of calls) if (call.blocking) onWait(key, false);
		calls.clear();
	};
	return {
		observe(event: { type?: string; toolCallId?: unknown; toolName?: string; args?: unknown; message?: unknown }) {
			if (event.type === "tool_execution_start" && event.toolName) {
				const key = toolTimeoutCallKey(event, ++sequence);
				const blocking = isBlockingSupervisorTool(event.toolName, event.args);
				calls.set(key, { tool: event.toolName, blocking });
				if (blocking) onWait(key, true);
			} else if (event.type === "tool_execution_end" || event.type === "tool_result_end") {
				const message = event.message as { toolCallId?: unknown; toolName?: string } | undefined;
				const id = message?.toolCallId ?? event.toolCallId;
				const tool = message?.toolName ?? event.toolName;
				const key = typeof id === "string" ? `id:${id}` : [...calls].find(([, call]) => call.tool === tool)?.[0];
				if (!key) return;
				if (calls.get(key)?.blocking) onWait(key, false);
				calls.delete(key);
			}
		},
		dispose: clear,
	};
}
