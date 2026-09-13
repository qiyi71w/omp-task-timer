import { describe, expect, test } from "bun:test";
import { registerTaskDuration, type TaskDurationDependencies } from "../task-duration.ts";
import type { NotificationConfig, TaskFinishedEvent } from "../webhook-notification.ts";

interface TestContext {
	hasUI: boolean;
	cwd: string;
	sessionManager: {
		getSessionId(): string;
		getSessionName(): string | undefined;
	};
	ui: {
		setWidget(...args: unknown[]): void;
		theme: { fg(color: string, text: string): string };
	};
}

type Handler = (event: Record<string, unknown>, context: TestContext) => unknown;

interface TimerHarness {
	emit(name: string, event?: Record<string, unknown>): Promise<void>;
	notifications: TaskFinishedEvent[];
	widgets: unknown[][];
	failPost(): void;
	setNow(value: number): void;
	setTitle(value: string | undefined): void;
	setCwd(value: string): void;
	setSessionId(value: string): void;
}

const ENABLED_CONFIG: Extract<NotificationConfig, { enabled: true }> = {
	enabled: true,
	url: "https://notify.example/hook",
	token: "secret",
	timeoutMs: 10_000,
};

function createHarness(initialNow = 0, initialSessionId = "main-session"): TimerHarness {
	const handlers = new Map<string, Handler[]>();
	const notifications: TaskFinishedEvent[] = [];
	const widgets: unknown[][] = [];
	let now = initialNow;
	let title: string | undefined = "Original Title";
	let cwd = "/work/one";
	let sessionId = initialSessionId;
	let postFails = false;
	const dependencies: TaskDurationDependencies = {
		now: () => now,
		newEventId: () => `event-${notifications.length + 1}`,
		config: ENABLED_CONFIG,
		post: async event => {
			notifications.push(event);
			if (postFails) throw new Error("simulated delivery failure");
			return { ok: true, partial: false, status: 200, channels: { discord: "sent", telegram: "sent" } };
		},
	};
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		logger: { warn() {} },
	};
	registerTaskDuration(pi as never, dependencies);

	const context = () => ({
		hasUI: true,
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => title,
		},
		ui: {
			setWidget: (...args: unknown[]) => widgets.push(args),
			theme: { fg: (_color: string, text: string) => text },
		},
	});
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, context());
	};
	return {
		emit,
		notifications,
		widgets,
		failPost() {
			postFails = true;
		},
		setNow(value: number) {
			now = value;
		},
		setTitle(value: string | undefined) {
			title = value;
		},
		setCwd(value: string) {
			cwd = value;
		},
		setSessionId(value: string) {
			sessionId = value;
		},
	};
}

async function startMainTask(harness: TimerHarness): Promise<void> {
	await harness.emit("input", { source: "interactive", text: "do work" });
	await harness.emit("before_agent_start");
	await harness.emit("agent_start");
}

const assistant = (stopReason: string) => ({ role: "assistant", stopReason });

describe("task duration webhook settlement", () => {
	test("uses raw milliseconds at the 60 second boundary", async () => {
		const short = createHarness();
		await startMainTask(short);
		short.setNow(59_999);
		await short.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();
		expect(short.notifications).toHaveLength(0);

		const boundary = createHarness();
		await startMainTask(boundary);
		boundary.setNow(60_000);
		await boundary.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();
		expect(boundary.notifications).toEqual([
			expect.objectContaining({ durationMs: 60_000, status: "completed" }),
		]);
	});

	test("suppresses short failures and sends long cancellations", async () => {
		const failed = createHarness();
		await startMainTask(failed);
		failed.setNow(59_999);
		await failed.emit("agent_end", { messages: [assistant("error")] });
		await Promise.resolve();
		expect(failed.notifications).toHaveLength(0);

		const cancelled = createHarness();
		await startMainTask(cancelled);
		cancelled.setNow(65_432);
		await cancelled.emit("agent_end", { messages: [assistant("aborted")] });
		await Promise.resolve();
		expect(cancelled.notifications).toEqual([
			expect.objectContaining({ durationMs: 65_432, status: "cancelled" }),
		]);
		expect(cancelled.widgets.at(-1)?.[1]).toEqual(["■ Task interrupted · 1m 5s"]);
	});

	test("settles once after automatic continuations and suppresses unconfirmed nested sessions", async () => {
		const continued = createHarness();
		await startMainTask(continued);
		continued.setNow(60_000);
		await continued.emit("agent_end", { willContinue: true, messages: [assistant("stop")] });
		await continued.emit("before_agent_start");
		await continued.emit("agent_start");
		continued.setNow(120_000);
		await continued.emit("session_stop", { session_id: "main-session" });
		await continued.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();
		expect(continued.notifications).toEqual([
			expect.objectContaining({ durationMs: 120_000, status: "completed" }),
		]);
		await continued.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();
		expect(continued.notifications).toHaveLength(1);

		const nested = createHarness();
		await nested.emit("before_agent_start");
		await nested.emit("agent_start");
		nested.setNow(120_000);
		await nested.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();
		expect(nested.notifications).toHaveLength(0);
	});

	test("uses session_stop only as headless main-session identity evidence", async () => {
		const headless = createHarness();
		await headless.emit("before_agent_start");
		await headless.emit("agent_start");
		headless.setNow(60_000);
		await headless.emit("session_stop", { session_id: "main-session" });
		await headless.emit("agent_end", { messages: [assistant("error")] });
		await Promise.resolve();
		expect(headless.notifications).toEqual([expect.objectContaining({ status: "failed" })]);
	});

	test("isolates switched sessions and reads the settled session's live title", async () => {
		const harness = createHarness();
		await startMainTask(harness);
		harness.setNow(30_000);
		await harness.emit("session_before_switch");

		harness.setSessionId("second-session");
		harness.setCwd("/work/two");
		harness.setTitle("Second Title");
		await harness.emit("session_switch");
		await startMainTask(harness);
		harness.setTitle("Retitled\n保持格式");
		harness.setCwd("/work/changed-after-start");
		harness.setNow(90_000);
		await harness.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();

		expect(harness.notifications).toEqual([
			expect.objectContaining({
				title: "Retitled\n保持格式",
				directory: "/work/two",
				durationMs: 60_000,
			}),
		]);
	});

	test("keeps a running task when a session transition is cancelled", async () => {
		for (const eventName of ["session_before_switch", "session_before_branch", "session_before_tree"]) {
			const harness = createHarness();
			await startMainTask(harness);
			harness.setNow(30_000);
			await harness.emit(eventName);
			harness.setNow(60_000);
			await harness.emit("agent_end", { messages: [assistant("stop")] });
			await Promise.resolve();

			expect(harness.notifications).toEqual([expect.objectContaining({ durationMs: 60_000 })]);
			expect(harness.widgets.at(-1)?.[1]).toEqual(["✓ Task finished · 1m 0s"]);
		}
	});

	test("suppresses notification when OMP has no session title", async () => {
		const harness = createHarness();
		await startMainTask(harness);
		harness.setTitle(undefined);
		harness.setNow(60_000);
		await harness.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();

		expect(harness.notifications).toHaveLength(0);
		expect(harness.widgets.at(-1)?.[1]).toEqual(["✓ Task finished · 1m 0s"]);
	});

	test("keeps concurrent extension instances isolated", async () => {
		const first = createHarness(0, "first-session");
		first.setTitle("First Title");
		first.setCwd("/work/first");
		await startMainTask(first);

		const second = createHarness(10_000, "second-session");
		second.setTitle("Second Title");
		second.setCwd("/work/second");
		await startMainTask(second);

		first.setNow(60_000);
		await first.emit("agent_end", { messages: [assistant("stop")] });
		second.setNow(71_000);
		await second.emit("agent_end", { messages: [assistant("error")] });
		await Promise.resolve();

		expect(first.notifications).toEqual([
			expect.objectContaining({ title: "First Title", directory: "/work/first", durationMs: 60_000 }),
		]);
		expect(second.notifications).toEqual([
			expect.objectContaining({ title: "Second Title", directory: "/work/second", durationMs: 61_000 }),
		]);
	});

	test("contains delivery rejection without affecting the settled UI", async () => {
		const harness = createHarness();
		await startMainTask(harness);
		harness.failPost();
		harness.setNow(60_000);

		await harness.emit("agent_end", { messages: [assistant("stop")] });
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.notifications).toHaveLength(1);
		expect(harness.widgets.at(-1)?.[1]).toEqual(["✓ Task finished · 1m 0s"]);
	});
});
