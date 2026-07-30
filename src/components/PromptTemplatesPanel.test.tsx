import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ndjsonResponse } from "#/test/ndjson";
import { PromptTemplatesPanel } from "./PromptTemplatesPanel";

type PromptFeature = "period-digest" | "profile-analysis" | "search-discussion";

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
}

function promptTemplateResponse(
	feature: PromptFeature,
	options: { isCustom?: boolean; parseError?: string } = {},
) {
	const label =
		feature === "period-digest"
			? "Today"
			: feature === "profile-analysis"
				? "Analyse"
				: "Discuss";
	return {
		ok: true,
		template: {
			feature,
			system: `${label} system`,
			requirements: `${label} requirements`,
			isCustom: options.isCustom ?? false,
			schemaVersion: 1,
			...(options.parseError ? { parseError: options.parseError } : {}),
		},
		definition: {
			label,
			description: `${label} description`,
			protocol: {
				system: `${label} protocol system`,
				taskInstruction: `${label} fixed task instruction`,
				requirements: `${label} protocol requirements`,
			},
		},
	};
}

function periodResult(markdown: string) {
	return {
		markdown,
		digest: {
			title: "Today",
			summary: "Summary",
			keyTopics: [],
			notableLinks: [],
			people: [],
			actionItems: [],
			sourceTweetIds: [],
		},
		parseStatus: "structured",
		generatedAt: "2026-07-30T12:00:00.000Z",
	};
}

function discussionResult(markdown: string) {
	return {
		markdown,
		discussion: {
			title: "Discuss",
			summary: "Summary",
			themes: [],
			tensions: [],
			followUps: [],
			sourceTweetIds: [],
			sourceDmConversationIds: [],
		},
		parseStatus: "fallback",
		generatedAt: "2026-07-30T12:00:00.000Z",
	};
}

function profileResult(markdown: string) {
	return {
		ok: true,
		result: {
			markdown,
			analysis: {
				title: "Alice",
				summary: "Summary",
				voice: "Direct",
				themes: [],
				conversationStyle: "Concise",
				notableSignals: [],
				risks: [],
				followUps: [],
				sourceTweetIds: [],
				sourceHandles: ["alice"],
			},
			parseStatus: "structured",
			generatedAt: "2026-07-30T12:00:00.000Z",
		},
	};
}

function featureFromUrl(url: URL): PromptFeature {
	return url.searchParams.get("feature") as PromptFeature;
}

function metadataResponse(handles: string[] = ["alice"]) {
	return jsonResponse({
		following: handles.map((handle) => ({ handle })),
		analyzed: [],
	});
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("PromptTemplatesPanel", () => {
	it("shows the fixed task instruction in the advanced prompt preview", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (url.pathname === "/api/prompt-templates") {
					return jsonResponse(promptTemplateResponse(featureFromUrl(url)));
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		await screen.findByDisplayValue("Today system");
		fireEvent.click(screen.getByRole("checkbox", { name: "Advanced mode" }));

		expect(screen.getByText(/Today fixed task instruction/u)).toHaveTextContent(
			/Today fixed task instruction\s+Requirements:/u,
		);
	});

	it("previews every locked prompt segment and edits feature inputs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return jsonResponse({
						following: [
							{ handle: "@alice" },
							{ handle: 42 },
							{ handle: "@alice" },
						],
					});
				}
				if (url.pathname === "/api/prompt-templates") {
					return jsonResponse(promptTemplateResponse(featureFromUrl(url)));
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="zh-CN" />);
		await screen.findByDisplayValue("Today system");
		fireEvent.click(screen.getByRole("button", { name: "Today" }));
		fireEvent.change(screen.getByLabelText("System message"), {
			target: { value: "Edited system" },
		});
		fireEvent.change(screen.getByLabelText("Requirements"), {
			target: { value: "Edited requirements" },
		});
		const todayInputs = screen.getAllByRole("combobox");
		fireEvent.change(todayInputs[0], { target: { value: "week" } });
		fireEvent.change(todayInputs[1], { target: { value: "following" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "Advanced mode" }));
		expect(screen.getByText(/Window \/ time range/u)).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
		expect(
			await screen.findByText(/Profile \/ account cache/u),
		).toHaveTextContent(/Analyse fixed task instruction/u);
		expect(
			screen.getByText(/dynamic Simplified Chinese suffix/u),
		).toBeVisible();
		fireEvent.change(screen.getByPlaceholderText("handle"), {
			target: { value: "bob" },
		});
		expect(screen.getByPlaceholderText("handle")).toHaveValue("bob");

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		expect(
			await screen.findByText(/Search query \/ source/u),
		).toHaveTextContent(/Discuss fixed task instruction/u);
	});

	it("ignores template completion after unmount and tolerates metadata failures", async () => {
		let templateAttempt = 0;
		let metadataAttempt = 0;
		const pendingTemplates: Array<{
			resolve: (response: Response) => void;
			reject: (error: unknown) => void;
		}> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((input: RequestInfo | URL): Promise<Response> => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					metadataAttempt += 1;
					return metadataAttempt === 1
						? Promise.resolve(jsonResponse(null))
						: Promise.reject(new Error("metadata unavailable"));
				}
				if (url.pathname === "/api/prompt-templates") {
					templateAttempt += 1;
					return new Promise<Response>((resolve, reject) => {
						pendingTemplates.push({ resolve, reject });
					});
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		const first = render(<PromptTemplatesPanel aiLanguage="en" />);
		await waitFor(() => expect(pendingTemplates).toHaveLength(1));
		first.unmount();
		await act(async () => {
			pendingTemplates[0].resolve(
				jsonResponse(promptTemplateResponse("period-digest")),
			);
		});

		const second = render(<PromptTemplatesPanel aiLanguage="en" />);
		await waitFor(() => expect(pendingTemplates).toHaveLength(2));
		second.unmount();
		await act(async () => {
			pendingTemplates[1].reject(new Error("late template failure"));
		});
		expect(templateAttempt).toBe(2);
	});

	it("supports cancelling reset and surfaces save failures", async () => {
		let resetRequests = 0;
		vi.spyOn(window, "confirm").mockReturnValue(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (
					url.pathname === "/api/prompt-templates" &&
					init?.method !== "POST"
				) {
					return jsonResponse(
						promptTemplateResponse(featureFromUrl(url), { isCustom: true }),
					);
				}
				if (
					url.pathname === "/api/prompt-templates" &&
					init?.method === "POST"
				) {
					return jsonResponse(
						{ ok: false, message: "save unavailable" },
						{ status: 500 },
					);
				}
				if (url.pathname === "/api/prompt-templates/reset") {
					resetRequests += 1;
					return jsonResponse(promptTemplateResponse("period-digest"));
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		fireEvent.change(await screen.findByLabelText("System message"), {
			target: { value: "Edited system" },
		});
		fireEvent.change(screen.getByLabelText("Requirements"), {
			target: { value: "Edited requirements" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Restore default" }));
		expect(resetRequests).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: "Save template" }));
		expect(await screen.findByText("save unavailable")).toBeVisible();
	});

	it("surfaces Today HTTP, stream, and transport failures", async () => {
		let runAttempt = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (url.pathname === "/api/prompt-templates") {
					return jsonResponse(promptTemplateResponse(featureFromUrl(url)));
				}
				if (url.pathname === "/api/prompt-playground/period-digest") {
					runAttempt += 1;
					if (runAttempt === 1) {
						return jsonResponse(
							{ message: "invalid playground input" },
							{ status: 400 },
						);
					}
					if (runAttempt === 2) {
						return new Response("not json", { status: 500 });
					}
					if (runAttempt === 3) {
						return new Response(null, { status: 200 });
					}
					if (runAttempt === 4) {
						throw new Error("playground network failed");
					}
					if (runAttempt === 5) {
						return Promise.reject("raw transport failure");
					}
					return ndjsonResponse([
						{ type: "error", error: "Today stream failed" },
					]);
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		const run = await screen.findByRole("button", { name: "Run" });
		for (const message of [
			"invalid playground input",
			"Playground request failed",
			"Playground stream was unavailable",
			"playground network failed",
			"Run failed",
			"Today stream failed",
		]) {
			fireEvent.click(run);
			expect(await screen.findByText(message)).toBeVisible();
		}
		expect(runAttempt).toBe(6);
	});

	it("warns about cache cost and confirms before replacing a corrupt template", async () => {
		const requests: Array<{ url: URL; init?: RequestInit }> = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				requests.push({ url, init });
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (
					url.pathname === "/api/prompt-templates" &&
					init?.method !== "POST"
				) {
					return jsonResponse(
						promptTemplateResponse(featureFromUrl(url), {
							isCustom: true,
							parseError: "markers are invalid",
						}),
					);
				}
				if (
					url.pathname === "/api/prompt-templates" &&
					init?.method === "POST"
				) {
					return jsonResponse(
						promptTemplateResponse("period-digest", { isCustom: true }),
					);
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const confirm = vi
			.spyOn(window, "confirm")
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);

		render(<PromptTemplatesPanel aiLanguage="en" />);

		expect(await screen.findByText(/Template parsing failed/u)).toBeVisible();
		expect(screen.getByText(/invalidates matching AI caches/u)).toBeVisible();
		expect(screen.getByText(/may incur real AI usage charges/u)).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "Save template" }));
		expect(
			requests.filter(
				(request) =>
					request.url.pathname === "/api/prompt-templates" &&
					request.init?.method === "POST",
			),
		).toHaveLength(0);

		fireEvent.click(screen.getByRole("button", { name: "Save template" }));
		expect(await screen.findByText("Template saved.")).toBeVisible();
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it("surfaces reset errors and restores defaults after a retry", async () => {
		let resetAttempts = 0;
		vi.spyOn(window, "confirm").mockReturnValue(true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (
					url.pathname === "/api/prompt-templates" &&
					init?.method !== "POST"
				) {
					return jsonResponse(
						promptTemplateResponse(featureFromUrl(url), { isCustom: true }),
					);
				}
				if (url.pathname === "/api/prompt-templates/reset") {
					resetAttempts += 1;
					return resetAttempts === 1
						? jsonResponse(
								{ ok: false, message: "cannot delete template" },
								{ status: 400 },
							)
						: jsonResponse(promptTemplateResponse("period-digest"));
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		const reset = await screen.findByRole("button", {
			name: "Restore default",
		});
		fireEvent.click(reset);
		expect(await screen.findByText("cannot delete template")).toBeVisible();

		fireEvent.click(reset);
		expect(await screen.findByText("Default template restored.")).toBeVisible();
		expect(reset).toBeDisabled();
	});

	it("streams Today and renders its structured parse status", async () => {
		let playgroundBody: unknown;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (url.pathname === "/api/prompt-templates") {
					return jsonResponse(promptTemplateResponse(featureFromUrl(url)));
				}
				if (url.pathname === "/api/prompt-playground/period-digest") {
					playgroundBody = JSON.parse(String(init?.body));
					return ndjsonResponse([
						{ type: "delta", delta: "# Local Today" },
						{ type: "done", result: periodResult("# Local Today") },
					]);
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		fireEvent.click(await screen.findByRole("button", { name: "Run" }));

		expect(
			await screen.findByRole("heading", { name: "Local Today" }),
		).toBeVisible();
		expect(playgroundBody).toMatchObject({
			period: "today",
			contentSource: "all",
			language: "en",
		});
		expect(screen.getByText(/Structured output parsed/u)).toBeVisible();
	});

	it("stops an in-flight Today request and returns to idle", async () => {
		let pendingRun:
			| { signal: AbortSignal; resolve: (response: Response) => void }
			| undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
					const url = new URL(String(input), "http://localhost");
					if (url.pathname === "/api/profile-analysis-metadata") {
						return Promise.resolve(metadataResponse());
					}
					if (url.pathname === "/api/prompt-templates") {
						return Promise.resolve(
							jsonResponse(promptTemplateResponse(featureFromUrl(url))),
						);
					}
					if (url.pathname === "/api/prompt-playground/period-digest") {
						return new Promise<Response>((resolve) => {
							pendingRun = { signal: init?.signal as AbortSignal, resolve };
						});
					}
					throw new Error(`Unexpected request: ${url.pathname}`);
				},
			),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		fireEvent.click(await screen.findByRole("button", { name: "Run" }));
		await waitFor(() => expect(pendingRun).toBeDefined());
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));

		expect(pendingRun?.signal.aborted).toBe(true);
		expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
		await act(async () => {
			pendingRun?.resolve(
				ndjsonResponse([{ type: "done", result: periodResult("ignored") }]),
			);
		});
		expect(screen.queryByText("ignored")).not.toBeInTheDocument();
	});

	it("handles Analyse success and Discuss terminal errors without mixing modes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (url.pathname === "/api/prompt-templates") {
					return jsonResponse(promptTemplateResponse(featureFromUrl(url)));
				}
				if (url.pathname === "/api/prompt-playground/profile-analysis") {
					return jsonResponse(profileResult("# Local Analyse"));
				}
				if (url.pathname === "/api/prompt-playground/search-discussion") {
					return ndjsonResponse([
						{ type: "error", error: "discussion failed" },
					]);
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		fireEvent.click(await screen.findByRole("button", { name: "Analyse" }));
		await screen.findByDisplayValue("alice");
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		expect(
			await screen.findByRole("heading", { name: "Local Analyse" }),
		).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
		const query = await screen.findByPlaceholderText(
			"Search the local archive",
		);
		fireEvent.change(query, { target: { value: "local-first" } });
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		expect(await screen.findByText("discussion failed")).toBeVisible();
		expect(screen.queryByText("Local Analyse")).not.toBeInTheDocument();
	});

	it("reports template load failures and empty profile metadata", async () => {
		let templateAttempts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return jsonResponse({});
				}
				if (url.pathname === "/api/prompt-templates") {
					templateAttempts += 1;
					return templateAttempts === 1
						? jsonResponse(
								{ ok: false, message: "template unavailable" },
								{ status: 500 },
							)
						: jsonResponse(promptTemplateResponse(featureFromUrl(url)));
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		const first = render(<PromptTemplatesPanel aiLanguage="en" />);
		expect(await screen.findByText("template unavailable")).toBeVisible();
		first.unmount();

		render(<PromptTemplatesPanel aiLanguage="en" />);
		fireEvent.click(await screen.findByRole("button", { name: "Analyse" }));
		expect(
			await screen.findByText(
				"No locally indexed profile options are available.",
			),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
	});

	it("renders a Discuss fallback result", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/profile-analysis-metadata") {
					return metadataResponse();
				}
				if (url.pathname === "/api/prompt-templates") {
					return jsonResponse(promptTemplateResponse(featureFromUrl(url)));
				}
				if (url.pathname === "/api/prompt-playground/search-discussion") {
					return ndjsonResponse([
						{ type: "delta", delta: "# Local Discuss" },
						{ type: "done", result: discussionResult("# Local Discuss") },
					]);
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<PromptTemplatesPanel aiLanguage="en" />);
		fireEvent.click(await screen.findByRole("button", { name: "Discuss" }));
		fireEvent.change(
			await screen.findByPlaceholderText("Search the local archive"),
			{ target: { value: "local-first" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Run" }));

		expect(
			await screen.findByRole("heading", { name: "Local Discuss" }),
		).toBeVisible();
		expect(screen.getByText(/Structured output fallback used/u)).toBeVisible();
	});
});
