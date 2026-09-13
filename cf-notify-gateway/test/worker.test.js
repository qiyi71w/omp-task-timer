import { describe, expect, test } from "bun:test";
import { createNotifyGateway } from "../src/worker.js";

const ENV = {
	INBOUND_SECRET: "gateway secret",
	DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
	TELEGRAM_BOT_TOKEN: "123456:bot-token",
	TELEGRAM_CHAT_ID: "-100123456",
};

const EVENT = {
	schemaVersion: 1,
	eventId: "018f-test-event",
	event: "task.finished",
	source: "omp",
	title: "Keep title — 原样",
	directory: "/work/项目",
	durationMs: 60_000,
	status: "completed",
};

function hookRequest(token = ENV.INBOUND_SECRET, event = EVENT) {
	return new Request("https://notify.example/hook", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(event),
	});
}

describe("Cloudflare notification gateway", () => {
	test("authenticates and delivers the same four mobile fields to both channels", async () => {
		const requests = [];
		const gateway = createNotifyGateway({
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request.clone());
				if (request.url.startsWith(ENV.DISCORD_WEBHOOK_URL)) return new Response(null, { status: 204 });
				return Response.json({ ok: true });
			},
		});

		const response = await gateway.fetch(hookRequest(), ENV);
		const expectedText = [
			"Task: Keep title — 原样",
			"Directory: /work/项目",
			"Duration: 1m 0s",
			"Status: completed",
		].join("\n");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			eventId: EVENT.eventId,
			channels: { discord: "sent", telegram: "sent" },
		});
		expect(requests).toHaveLength(2);
		const discord = requests.find(request => request.url.startsWith(ENV.DISCORD_WEBHOOK_URL));
		const telegram = requests.find(request => request.url.startsWith("https://api.telegram.org/"));
		expect(new URL(discord.url).searchParams.get("wait")).toBe("true");
		expect(await discord.json()).toEqual({ content: expectedText, allowed_mentions: { parse: [] } });
		expect(await telegram.json()).toEqual({ chat_id: ENV.TELEGRAM_CHAT_ID, text: expectedText });
	});

	test("runs channels concurrently and reports Telegram ok false as partial delivery", async () => {
		const release = Promise.withResolvers();
		const bothStarted = Promise.withResolvers();
		let started = 0;
		const gateway = createNotifyGateway({
			fetch: async input => {
				const url = String(input);
				started++;
				if (started === 2) bothStarted.resolve();
				await release.promise;
				if (url.startsWith(ENV.DISCORD_WEBHOOK_URL)) return new Response(null, { status: 204 });
				return Response.json({ ok: false, description: "chat rejected" });
			},
		});

		const responsePromise = gateway.fetch(hookRequest(), ENV);
		await bothStarted.promise;
		expect(started).toBe(2);
		release.resolve();
		const response = await responsePromise;
		expect(response.status).toBe(207);
		expect(await response.json()).toEqual({
			ok: false,
			eventId: EVENT.eventId,
			channels: { discord: "sent", telegram: "failed" },
		});
	});

	test("returns 502 when neither channel accepts the event", async () => {
		const gateway = createNotifyGateway({
			fetch: async input => {
				if (String(input).startsWith(ENV.DISCORD_WEBHOOK_URL)) return new Response("rejected", { status: 500 });
				return Response.json({ ok: false }, { status: 200 });
			},
		});

		const response = await gateway.fetch(hookRequest(), ENV);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			ok: false,
			eventId: EVENT.eventId,
			channels: { discord: "failed", telegram: "failed" },
		});
	});

	test("applies each provider timeout through response-body completion", async () => {
		const gateway = createNotifyGateway({
			providerTimeoutMs: 20,
			fetch: async input => {
				if (String(input).startsWith(ENV.DISCORD_WEBHOOK_URL)) {
					return new Response(new ReadableStream({ pull() {} }), { status: 200 });
				}
				return Response.json({ ok: true });
			},
		});

		const response = await gateway.fetch(hookRequest(), ENV);
		expect(response.status).toBe(207);
		expect(await response.json()).toEqual({
			ok: false,
			eventId: EVENT.eventId,
			channels: { discord: "unknown", telegram: "sent" },
		});
	});

	test("rejects wrong routes and bearer tokens before provider dispatch", async () => {
		let providerCalls = 0;
		const gateway = createNotifyGateway({
			fetch: async () => {
				providerCalls++;
				return new Response(null, { status: 204 });
			},
		});

		const wrongRoute = await gateway.fetch(new Request("https://notify.example/not-hook"), ENV);
		expect(wrongRoute.status).toBe(404);
		const wrongMethod = await gateway.fetch(new Request("https://notify.example/hook"), ENV);
		expect(wrongMethod.status).toBe(405);
		const unauthorized = await gateway.fetch(hookRequest("wrong secret"), ENV);
		expect(unauthorized.status).toBe(401);
		expect(providerCalls).toBe(0);
	});

	test("rejects JSON lookalike media types before provider dispatch", async () => {
		let providerCalls = 0;
		const gateway = createNotifyGateway({
			fetch: async () => {
				providerCalls++;
				return Response.json({ ok: true });
			},
		});
		const request = new Request("https://notify.example/hook", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ENV.INBOUND_SECRET}`,
				"Content-Type": "application/jsonp",
			},
			body: JSON.stringify(EVENT),
		});

		const response = await gateway.fetch(request, ENV);
		expect(response.status).toBe(415);
		expect(providerCalls).toBe(0);

		const parameterized = new Request("https://notify.example/hook", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ENV.INBOUND_SECRET}`,
				"Content-Type": "Application/JSON; charset=\"utf-8\"",
			},
			body: JSON.stringify(EVENT),
		});
		const accepted = await gateway.fetch(parameterized, ENV);
		expect(accepted.status).toBe(200);
		expect(providerCalls).toBe(2);
	});

	test("preserves Unicode but rejects oversized or invalid versioned events", async () => {
		let providerCalls = 0;
		const gateway = createNotifyGateway({
			fetch: async () => {
				providerCalls++;
				return new Response(null, { status: 204 });
			},
		});

		const oversized = await gateway.fetch(hookRequest(ENV.INBOUND_SECRET, { ...EVENT, title: "界".repeat(11_000) }), ENV);
		expect(oversized.status).toBe(413);
		const unsupportedVersion = await gateway.fetch(
			hookRequest(ENV.INBOUND_SECRET, { ...EVENT, schemaVersion: 2 }),
			ENV,
		);
		expect(unsupportedVersion.status).toBe(400);
		expect(providerCalls).toBe(0);
	});
	test("delivers through Telegram when Discord is disabled", async () => {
		const requests = [];
		const gateway = createNotifyGateway({
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json({ ok: true });
			},
		});

		const response = await gateway.fetch(hookRequest(), { ...ENV, DISCORD_WEBHOOK_URL: "" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			eventId: EVENT.eventId,
			channels: { discord: "disabled", telegram: "sent" },
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toStartWith("https://api.telegram.org/");
	});

	test("delivers through Discord when Telegram is disabled", async () => {
		let providerCalls = 0;
		const gateway = createNotifyGateway({
			fetch: async () => {
				providerCalls++;
				return new Response(null, { status: 204 });
			},
		});
		const response = await gateway.fetch(hookRequest(), {
			...ENV,
			TELEGRAM_BOT_TOKEN: "",
			TELEGRAM_CHAT_ID: "",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			eventId: EVENT.eventId,
			channels: { discord: "sent", telegram: "disabled" },
		});
		expect(providerCalls).toBe(1);
	});

	test("rejects empty or incomplete channel configuration", async () => {
		let providerCalls = 0;
		const gateway = createNotifyGateway({
			fetch: async () => {
				providerCalls++;
				return new Response(null, { status: 204 });
			},
		});
		const disabled = { ...ENV, DISCORD_WEBHOOK_URL: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" };
		const incomplete = { ...disabled, TELEGRAM_BOT_TOKEN: ENV.TELEGRAM_BOT_TOKEN };

		expect((await gateway.fetch(hookRequest(), disabled)).status).toBe(503);
		expect((await gateway.fetch(hookRequest(), incomplete)).status).toBe(503);
		expect(providerCalls).toBe(0);
	});

	test("truncates only display fields within each provider limit", async () => {
		const contents = [];
		const gateway = createNotifyGateway({
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const body = await request.json();
				contents.push(body.content ?? body.text);
				return request.url.startsWith(ENV.DISCORD_WEBHOOK_URL)
					? new Response(null, { status: 204 })
					: Response.json({ ok: true });
			},
		});
		const longEvent = {
			...EVENT,
			title: `通知 <@123> ${"😀".repeat(2_040)}`,
			directory: `/目录/${"界".repeat(5_000)}`,
			status: "cancelled",
		};

		const response = await gateway.fetch(hookRequest(ENV.INBOUND_SECRET, longEvent), ENV);
		expect(response.status).toBe(200);
		expect(contents[0].length).toBeLessThanOrEqual(2_000);
		expect(contents[1].length).toBeLessThanOrEqual(4_096);
		for (const content of contents) {
			expect(content).toContain("Duration: 1m 0s");
			expect(content).toContain("Status: cancelled");
			expect(content).not.toContain("�");
		}
	});
});
