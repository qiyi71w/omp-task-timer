import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	loadNotificationConfig,
	postTaskFinished,
	type NotificationConfig,
	type NotificationDeliveryResult,
	type TaskFinishedEvent,
	type TaskFinishedStatus,
} from "./webhook-notification.ts";

const WIDGET_KEY = "omp-task-timer.duration";
const MINIMUM_NOTIFICATION_DURATION_MS = 60_000;

export interface TaskDurationDependencies {
	now(): number;
	newEventId(): string;
	config: NotificationConfig;
	post(event: Readonly<TaskFinishedEvent>): Promise<NotificationDeliveryResult>;
}

interface ActiveTask {
	sessionId: string;
	directory: string;
	pendingStartedAt: number | undefined;
	startedAt: number | undefined;
	mainSessionConfirmed: boolean;
}

function formatDuration(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);

	if (totalMinutes === 0) return `${seconds}s`;

	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return hours === 0 ? `${minutes}m ${seconds}s` : `${hours}h ${minutes}m ${seconds}s`;
}

export function registerTaskDuration(
	pi: Pick<ExtensionAPI, "on" | "logger">,
	dependencies: TaskDurationDependencies,
): void {
	let active: ActiveTask | undefined;
	let confirmedMainSessionId: string | undefined;

	const warn = (message: string, details?: Record<string, unknown>): void => {
		try {
			pi.logger.warn(message, details);
		} catch {
			// Logging must not turn a notification failure into a session failure.
		}
	};
	const resetSession = (): void => {
		active = undefined;
		confirmedMainSessionId = undefined;
	};
	const currentSessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;
		confirmedMainSessionId = currentSessionId(ctx);
		if (active?.sessionId === confirmedMainSessionId) active.mainSessionConfirmed = true;
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		const sessionId = currentSessionId(ctx);
		if (active?.sessionId !== sessionId) active = undefined;
		if (!active) {
			active = {
				sessionId,
				directory: ctx.cwd,
				pendingStartedAt: dependencies.now(),
				startedAt: undefined,
				mainSessionConfirmed: confirmedMainSessionId === sessionId,
			};
		} else if (active.startedAt === undefined && active.pendingStartedAt === undefined) {
			active.pendingStartedAt = dependencies.now();
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		const sessionId = currentSessionId(ctx);
		if (active?.sessionId !== sessionId) {
			active = {
				sessionId,
				directory: ctx.cwd,
				pendingStartedAt: dependencies.now(),
				startedAt: undefined,
				mainSessionConfirmed: confirmedMainSessionId === sessionId,
			};
		}
		if (active.startedAt === undefined) active.startedAt = active.pendingStartedAt ?? dependencies.now();
		active.pendingStartedAt = undefined;
	});

	// OMP 18.1.x emits this only for the main session, immediately before the
	// corresponding final agent_end. It is identity evidence only: this hook may
	// request another turn, so notification remains in agent_end.
	pi.on("session_stop", (event, ctx) => {
		if (event.session_id !== currentSessionId(ctx) || active?.sessionId !== event.session_id) return;
		confirmedMainSessionId = event.session_id;
		active.mainSessionConfirmed = true;
	});

	pi.on("agent_end", (event, ctx) => {
		if (event.willContinue) return;

		const settled = active;
		active = undefined;
		if (!settled || settled.startedAt === undefined || settled.sessionId !== currentSessionId(ctx)) return;

		const durationMs = Math.max(0, dependencies.now() - settled.startedAt);
		let status: TaskFinishedStatus = "unknown";
		let resultLabel: string | undefined;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message.role !== "assistant") continue;
			switch (message.stopReason) {
				case "stop":
					status = "completed";
					resultLabel = "✓ Task finished";
					break;
				case "error":
					status = "failed";
					resultLabel = "✗ Task failed";
					break;
				case "aborted":
					status = "cancelled";
					resultLabel = "■ Task interrupted";
					break;
			}
			break;
		}

		if (resultLabel !== undefined && ctx.hasUI) {
			ctx.ui.setWidget(
				WIDGET_KEY,
				[ctx.ui.theme.fg("muted", `${resultLabel} · ${formatDuration(durationMs)}`)],
				{ placement: "aboveEditor" },
			);
		}

		const config = dependencies.config;
		const title = ctx.sessionManager.getSessionName();
		if (
			!config.enabled ||
			!settled.mainSessionConfirmed ||
			durationMs < MINIMUM_NOTIFICATION_DURATION_MS ||
			title === undefined
		) {
			return;
		}

		try {
			const snapshot = Object.freeze<TaskFinishedEvent>({
				schemaVersion: 1,
				eventId: dependencies.newEventId(),
				event: "task.finished",
				source: "omp",
				title,
				directory: settled.directory,
				durationMs,
				status,
			});
			void Promise.resolve()
				.then(() => dependencies.post(snapshot))
				.then(result => {
					if (!result.ok) {
						warn("Task webhook delivery was not fully successful", {
							status: result.status,
							partial: result.partial,
							channels: result.channels,
						});
					}
				})
				.catch(() => warn("Task webhook delivery failed"));
		} catch {
			warn("Task webhook snapshot could not be created");
		}
	});

	pi.on("session_start", resetSession);
	pi.on("session_switch", resetSession);
	pi.on("session_branch", resetSession);
	pi.on("session_tree", resetSession);
	pi.on("session_shutdown", resetSession);
}

export default function taskDuration(pi: ExtensionAPI): void {
	const config = loadNotificationConfig();
	if (/^(?:1|true|yes|on)$/i.test(process.env.OMP_NOTIFY_ENABLED?.trim() ?? "") && !config.enabled) {
		try {
			pi.logger.warn("Task webhook is enabled but OMP_NOTIFY_URL or OMP_NOTIFY_TOKEN is invalid");
		} catch {
			// The timer remains available even when logger wiring is unavailable.
		}
	}
	registerTaskDuration(pi, {
		now: () => performance.now(),
		newEventId: () => crypto.randomUUID(),
		config,
		post: event => {
			if (!config.enabled) return Promise.reject(new Error("Task webhook is disabled"));
			return postTaskFinished(config, event);
		},
	});
}
