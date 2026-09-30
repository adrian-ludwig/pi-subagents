import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runChildSession, type StepSteerHandler } from "../../src/runs/background/run-child-session.ts";
import type { ChildSessionEvent } from "../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import {
	childSessionHasQueuedMessages,
	createDefaultChildSessionFactory,
	type ChildSession,
	type ChildSessionLaunch,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";

describe("childSessionHasQueuedMessages", () => {
	it("treats a missing session or method as no queued input", () => {
		assert.equal(childSessionHasQueuedMessages(undefined), false);
		assert.equal(childSessionHasQueuedMessages({} as ChildSession), false);
	});

	it("keeps the drain hold when the session reports queued input", () => {
		assert.equal(childSessionHasQueuedMessages({ hasQueuedMessages: () => true } as ChildSession), true);
		assert.equal(childSessionHasQueuedMessages({ hasQueuedMessages: () => false } as ChildSession), false);
	});

	it("does not throw when hasQueuedMessages reads a missing agent", () => {
		const session = {
			hasQueuedMessages() {
				const agent: { hasQueuedMessages?: () => boolean } | undefined = undefined;
				return agent!.hasQueuedMessages!();
			},
		} as ChildSession;
		assert.equal(childSessionHasQueuedMessages(session), false);
	});
});

describe("default factory queued-message probe", () => {
	it("keeps a terminal acceptance report instead of consuming queued guidance after it", async () => {
		const report = "Complete implementation\n```acceptance-report\n" + JSON.stringify({ criteriaSatisfied: [], commandsRun: [{ command: "npm test", result: "passed" }] }) + "\n```";
		let listener: (event: ChildSessionEvent) => void = () => {};
		let queued = false;
		let steer: StepSteerHandler | undefined;
		const outcomes: string[] = [];
		const underlying = {
			agent: { hasQueuedMessages: () => queued },
			bindExtensions: async () => {}, dispose() {},
			extensionRunner: { hasHandlers: () => false },
			subscribe(callback: typeof listener) { listener = callback; return () => {}; },
			async prompt() {
				await steer?.({ type: "steer", id: "policy", ts: Date.now(), message: "Duplicate policy guidance", mode: "follow_up" });
				listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: report }], stopReason: "stop" } });
				if (queued) listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "```acceptance-report\n{\"criteriaSatisfied\":[],\"commandsRun\":[]}\n```" }], stopReason: "stop" } });
			},
			clearQueue() { queued = false; return { steering: [], followUp: ["Duplicate policy guidance"] }; },
			abort: async () => {}, steer: async () => { queued = true; }, followUp: async () => { queued = true; },
			messages: [], sessionId: "completed-report",
		};
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
			ModelRuntime: { create: async () => ({}) }, SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} }, SessionManager: { inMemory: () => ({}) },
			resolveCliModel: () => ({}), createAgentSession: async () => ({ session: underlying }),
		} as unknown as PiCodingAgentModule) });
		const child = await factory.create({ cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] });
		const result = await runChildSession({ factory: { create: async () => child, dispose: () => factory.dispose() }, launch: { session: { hooks: [] }, capture: { finalDrainHeld: () => false } } as unknown as InProcessChildLaunch, prompt: "Implement", timeoutMessage: "timeout", appendChildEvent() {}, writeOutputLine() {}, registerSteer(handler) { steer = handler; }, onSteerOutcome(_request, outcome) { outcomes.push(`${outcome.state}: ${outcome.message}`); } });
		assert.equal(result.finalOutput, report);
		assert.equal(result.exitCode, 0);
		assert.deepEqual(outcomes, ["failed: child completed before consuming follow-up"]);
		assert.equal(child.hasQueuedMessages?.(), false);
		await assert.rejects(child.steer("More guidance"), /acceptance report.*resume/i);
		await assert.rejects(child.followUp("New work"), /acceptance report.*resume/i);
	});
	it("rejects a required loader failure before requested-model resolution", async () => {
		let modelResolved = false;
		const requiredPath = "/tmp/required-provider.mjs";
		const factory = createDefaultChildSessionFactory({
			loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class {
					async reload() {}
					getExtensions() { return { extensions: [], errors: [{ path: requiredPath, error: "import failed" }], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] } }; }
				},
				resolveCliModel: () => { modelResolved = true; return {}; },
			} as unknown as PiCodingAgentModule),
		});
		await assert.rejects(() => factory.create({ cwd: process.cwd(), storage: { kind: "memory" }, model: "provider/model", extensionPaths: [requiredPath], requiredExtensions: [{ id: "provider", path: requiredPath }], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] }), /Required child extension failed to load/);
		assert.equal(modelResolved, false);
	});

	it("rejects a required provider-registration failure before requested-model resolution", async () => {
		let modelResolved = false;
		const requiredPath = "/tmp/required-provider.mjs";
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
			ModelRuntime: { create: async () => ({ registerProvider() { throw new Error("bad provider"); }, refresh: async () => {} }) },
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [{ name: "required", config: {}, extensionPath: requiredPath }], pendingNativeProviderRegistrations: [] } }; } },
			resolveCliModel: () => { modelResolved = true; return {}; },
		} as unknown as PiCodingAgentModule) });
		await assert.rejects(() => factory.create({ cwd: process.cwd(), storage: { kind: "memory" }, model: "provider/model", extensionPaths: [requiredPath], requiredExtensions: [{ id: "provider", path: requiredPath }], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] }), /provider registration failed.*bad provider/);
		assert.equal(modelResolved, false);
	});

	it("reports no queued messages for an agent-less wrapped session", async () => {
		const factory = createDefaultChildSessionFactory({
			loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({}) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class { async reload() {} },
				SessionManager: { inMemory: () => ({}) },
				resolveCliModel: () => ({}),
				createAgentSession: async () => ({
					session: {
						bindExtensions: async () => {},
						dispose() {},
						extensionRunner: { hasHandlers: () => false },
						subscribe: () => () => {},
						prompt: async () => {},
						abort: async () => {},
						steer: async () => {},
						followUp: async () => {},
						messages: [],
						sessionId: "agent-less",
					},
				}),
			} as unknown as PiCodingAgentModule),
		});
		const child = await factory.create({
			cwd: process.cwd(),
			storage: { kind: "memory" },
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		});
		assert.equal(child.hasQueuedMessages?.(), false);
		assert.equal(childSessionHasQueuedMessages(child), false);
	});

	it("re-arms from a wrapped session whose agent reports queued input", async () => {
		const factory = createDefaultChildSessionFactory({
			loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({}) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class { async reload() {} },
				SessionManager: { inMemory: () => ({}) },
				resolveCliModel: () => ({}),
				createAgentSession: async () => ({
					session: {
						agent: { hasQueuedMessages: () => true },
						bindExtensions: async () => {},
						dispose() {},
						extensionRunner: { hasHandlers: () => false },
						subscribe: () => () => {},
						prompt: async () => {},
						abort: async () => {},
						steer: async () => {},
						followUp: async () => {},
						messages: [],
						sessionId: "queued",
					},
				}),
			} as unknown as PiCodingAgentModule),
		});
		const child = await factory.create({
			cwd: process.cwd(),
			storage: { kind: "memory" },
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		});
		assert.equal(child.hasQueuedMessages?.(), true);
		assert.equal(childSessionHasQueuedMessages(child), true);
	});
});
