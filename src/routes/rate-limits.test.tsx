import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "./rate-limits";

const RateLimitsRoute = Route.options.component as ComponentType;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("rate limits route", () => {
	it("shows observed endpoint pressure and refreshes", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						generatedAt: "2026-05-31T12:00:00.000Z",
						windowMs: 900000,
						docsUrl: "https://docs.x.com/x-api/fundamentals/rate-limits",
						summary: {
							totalCallsLastWindow: 2,
							rateLimitedLastWindow: 1,
							errorLastWindow: 0,
							criticalEndpoints: 1,
							lastEventAt: "2026-05-31T11:59:00.000Z",
						},
						throttle: {
							conversationDelayMs: 3100,
							rateLimitRetryMs: 60000,
							rateLimitMaxRetries: 1,
						},
						endpoints: [
							{
								key: "tweets_search_recent",
								label: "Recent search",
								method: "GET",
								path: "/2/tweets/search/recent",
								description: "Conversation backfill searches",
								perAppLimit: 450,
								perUserLimit: 300,
								windowMs: 900000,
								callsLastWindow: 2,
								estimatedRemaining: 298,
								usagePercent: 1,
								rateLimitedLastWindow: 1,
								errorsLastWindow: 0,
								lastEventAt: "2026-05-31T11:59:00.000Z",
								lastRateLimitAt: "2026-05-31T11:58:00.000Z",
								estimatedResetAt: "2026-05-31T12:13:00.000Z",
								status: "critical",
							},
						],
						events: [
							{
								id: "evt_1",
								endpoint: "tweets_search_recent",
								status: "rate_limited",
								at: "2026-05-31T11:58:00.000Z",
								source: "profile-analysis:conversation",
								handle: "alice",
								detail: "Too Many Requests",
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						generatedAt: "2026-05-31T12:01:00.000Z",
						windowMs: 900000,
						docsUrl: "https://docs.x.com/x-api/fundamentals/rate-limits",
						summary: {
							totalCallsLastWindow: 0,
							rateLimitedLastWindow: 0,
							errorLastWindow: 0,
							criticalEndpoints: 0,
							lastEventAt: null,
						},
						throttle: {
							conversationDelayMs: 3100,
							rateLimitRetryMs: 60000,
							rateLimitMaxRetries: 1,
						},
						endpoints: [],
						events: [],
					}),
					{ headers: { "content-type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<RateLimitsRoute />);

		expect(await screen.findByText("Recent search")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
		expect(screen.getByText("1")).toBeInTheDocument();
		expect(screen.getByText("Too Many Requests")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
			"href",
			"https://docs.x.com/x-api/fundamentals/rate-limits",
		);

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});
});
