import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createActiveRuntimeTimeout, createSupervisorWaitTracker, isBlockingSupervisorTool } from "../../src/runs/shared/active-runtime-timeout.ts";

describe("active runtime timeout", () => {
	it("keeps the remaining budget across repeated and overlapping waits", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		let expired = 0;
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => expired++);
		t.mock.timers.tick(30);
		clock.setWaiting("a", true);
		t.mock.timers.tick(1000);
		clock.setWaiting("b", true);
		clock.setWaiting("a", false);
		t.mock.timers.tick(1000);
		assert.equal(expired, 0);
		assert.equal(clock.remainingMs(), 70);
		clock.setWaiting("b", false);
		t.mock.timers.tick(20);
		clock.setWaiting("a", true);
		t.mock.timers.tick(1000);
		clock.setWaiting("a", false);
		t.mock.timers.tick(49);
		assert.equal(expired, 0);
		t.mock.timers.tick(1);
		assert.equal(expired, 1);
		clock.dispose();
	});

	it("cleans up cancellation and retains active budget between attempts", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		let expired = 0;
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => expired++);
		t.mock.timers.tick(40);
		clock.setWaiting("cancelled", true);
		clock.stop();
		clock.setWaiting("cancelled", false);
		t.mock.timers.tick(1000);
		clock.start(() => expired++);
		t.mock.timers.tick(59);
		assert.equal(expired, 0);
		clock.dispose();
		t.mock.timers.tick(1000);
		assert.equal(expired, 0);
	});

	it("tracks overlapping call ids and progress updates without leaking waits", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		let expired = 0;
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => expired++);
		const tracker = createSupervisorWaitTracker(clock.setWaiting);
		tracker.observe({ type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: "a", args: { reason: "need_decision" } });
		tracker.observe({ type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: "progress", args: { reason: "progress_update" } });
		tracker.observe({ type: "tool_execution_start", toolName: "intercom", toolCallId: "b", args: { action: "ask" } });
		tracker.observe({ type: "tool_execution_end", toolName: "contact_supervisor", toolCallId: "progress" });
		tracker.observe({ type: "tool_execution_end", toolName: "contact_supervisor", toolCallId: "a" });
		t.mock.timers.tick(1000);
		assert.equal(expired, 0);
		tracker.dispose();
		t.mock.timers.tick(100);
		assert.equal(expired, 1);
		clock.dispose();
	});

	it("releases a wait whose events carry an empty call id", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		let expired = 0;
		const clock = createActiveRuntimeTimeout(100);
		clock.start(() => expired++);
		const tracker = createSupervisorWaitTracker(clock.setWaiting);
		tracker.observe({ type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: "", args: { reason: "need_decision" } });
		t.mock.timers.tick(1000);
		assert.equal(expired, 0);
		tracker.observe({ type: "tool_execution_end", toolName: "contact_supervisor", toolCallId: "" });
		t.mock.timers.tick(100);
		assert.equal(expired, 1);
		tracker.dispose();
		clock.dispose();
	});

	it("pauses only blocking coordination, never progress updates", () => {
		assert.equal(isBlockingSupervisorTool("contact_supervisor", { reason: "need_decision" }), true);
		assert.equal(isBlockingSupervisorTool("contact_supervisor", { reason: "interview_request" }), true);
		assert.equal(isBlockingSupervisorTool("intercom", { action: "ask" }), true);
		assert.equal(isBlockingSupervisorTool("contact_supervisor", { reason: "progress_update" }), false);
		assert.equal(isBlockingSupervisorTool("intercom", { action: "send" }), false);
	});
});
