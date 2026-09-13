import { describe, expect, test } from "bun:test";
import {
	loadNotificationConfig,
	postTaskFinished,
	type TaskFinishedEvent,
	type WebhookFetch,
} from "../webhook-notification.ts";

const EVENT: TaskFinishedEvent = {
	schemaVersion: 1,
	eventId: "018f-test-event",
	event: "task.finished",
	source: "omp",
	title: "Keep title — 原样",
	directory: "/work/project",
	durationMs: 60_000,
	status: "completed",
};

describe("webhook notification client", () => {
	test("is disabled unless explicitly enabled", () => {
		expect(loadNotificationConfig({})).toEqual({ enabled: false });
	});

	test("loads an enabled endpoint configuration", () => {
		expect(
			loadNotificationConfig({
				OMP_NOTIFY_ENABLED: "true",
				OMP_NOTIFY_URL: "https://notify.example/hook",
				OMP_NOTIFY_TOKEN: "secret token",
			}),
		).toEqual({
			enabled: true,
			url: "https://notify.example/hook",
			token: "secret token",
			timeoutMs: 10_000,
		});
	});

	test("does not expose an environment override for the fixed threshold", () => {
		expect(
			loadNotificationConfig({
				OMP_NOTIFY_ENABLED: "true",
				OMP_NOTIFY_URL: "https://notify.example/hook",
				OMP_NOTIFY_TOKEN: "secret token",
				OMP_NOTIFY_MIN_SECONDS: "0",
			}),
		).toEqual({
			enabled: true,
			url: "https://notify.example/hook",
			token: "secret token",
			timeoutMs: 10_000,
		});
	});

	test("posts the frozen protocol envelope and consumes the response body", async () => {
		let request: Request | undefined;
		let bodyRead = false;
		const fetchImpl: WebhookFetch = async (input, init) => {
			request = new Request(input, init);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'{"ok":true,"eventId":"018f-test-event","channels":{"discord":"sent","telegram":"sent"}}',
							),
						);
						controller.close();
						bodyRead = true;
					},
				}),
				{ status: 200 },
			);
		};

		const result = await postTaskFinished(
			{
				enabled: true,
				url: "https://notify.example/hook",
				token: "secret token",
				timeoutMs: 10_000,
			},
			Object.freeze({ ...EVENT }),
			fetchImpl,
		);

		expect(request?.method).toBe("POST");
		expect(request?.headers.get("authorization")).toBe("Bearer secret token");
		expect(request?.headers.get("content-type")).toBe("application/json");
		expect(await request?.json()).toEqual(EVENT);
		expect(bodyRead).toBe(true);
		expect(result).toEqual({
			ok: true,
			partial: false,
			status: 200,
			channels: { discord: "sent", telegram: "sent" },
		});
	});

	test("bounds the whole request including response-body reads", async () => {
		const hangingBody = new ReadableStream<Uint8Array>({ pull() {} });
		const fetchImpl: WebhookFetch = async () => new Response(hangingBody, { status: 200 });

		await expect(
			postTaskFinished(
				{
					enabled: true,
					url: "https://notify.example/hook",
					token: "secret token",
					timeoutMs: 20,
				},
				EVENT,
				fetchImpl,
			),
		).rejects.toHaveProperty("name", "TimeoutError");
	});

	test("does not accept HTTP success without confirmed channel results", async () => {
		const fetchImpl: WebhookFetch = async () =>
			Response.json({
				ok: false,
				eventId: EVENT.eventId,
				channels: { discord: "sent", telegram: "failed" },
			});

		const result = await postTaskFinished(
			{
				enabled: true,
				url: "https://notify.example/hook",
				token: "secret token",
				timeoutMs: 10_000,
			},
			EVENT,
			fetchImpl,
		);

		expect(result).toEqual({
			ok: false,
			partial: false,
			status: 200,
			channels: { discord: "sent", telegram: "failed" },
		});
	});
});
