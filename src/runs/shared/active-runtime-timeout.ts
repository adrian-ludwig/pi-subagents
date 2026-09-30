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
		dispose() { consume(); onTimeout = undefined; waits.clear(); },
	};
}

export type ActiveRuntimeTimeout = ReturnType<typeof createActiveRuntimeTimeout>;
