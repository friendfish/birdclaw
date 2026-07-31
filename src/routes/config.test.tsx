import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "./config";

const ConfigRoute = Route.options.component as ComponentType;

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
}

function configResponse() {
	return {
		ok: true,
		ai: {
			provider: "openai",
			baseUrl: "",
			apiKey: "",
			model: "gpt-test",
		},
		language: { aiLanguage: "en", uiLanguage: "en" },
	};
}

function scheduleResponse() {
	return {
		ok: true,
		archiveDir: "",
		schedule: {
			today: { hour: 8, minute: 0 },
			"24h": { hour: 8, minute: 45 },
			yesterday: { hour: 1, minute: 0 },
			week: { hour: 2, minute: 0, weekday: 1 },
		},
	};
}

function promptTemplateResponse(
	feature: "period-digest" | "profile-analysis" | "search-discussion",
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
			isCustom: false,
			schemaVersion: 1,
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

function profilePlaygroundResponse(markdown: string) {
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

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("config prompt panel", () => {
	it("aborts an active run and suppresses its late result when switching features", async () => {
		let pendingProfileRun:
			| {
					signal: AbortSignal;
					resolve: (response: Response) => void;
			  }
			| undefined;
		const fetchMock = vi.fn(
			(input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/config") {
					return Promise.resolve(jsonResponse(configResponse()));
				}
				if (url.pathname === "/api/digest-schedule") {
					return Promise.resolve(jsonResponse(scheduleResponse()));
				}
				if (url.pathname === "/api/profile-analysis-metadata") {
					return Promise.resolve(
						jsonResponse({ following: [{ handle: "alice" }], analyzed: [] }),
					);
				}
				if (url.pathname === "/api/prompt-templates") {
					const feature = url.searchParams.get("feature") as
						| "period-digest"
						| "profile-analysis"
						| "search-discussion";
					return Promise.resolve(jsonResponse(promptTemplateResponse(feature)));
				}
				if (url.pathname === "/api/prompt-playground/profile-analysis") {
					return new Promise<Response>((resolve) => {
						pendingProfileRun = {
							signal: init?.signal as AbortSignal,
							resolve,
						};
					});
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<ConfigRoute />);
		fireEvent.click(await screen.findByRole("button", { name: "提示词" }));
		fireEvent.click(await screen.findByRole("button", { name: "Analyse" }));
		await screen.findByDisplayValue("Analyse system");
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		await waitFor(() => expect(pendingProfileRun).toBeDefined());

		fireEvent.click(screen.getByRole("button", { name: "Today" }));
		await screen.findByDisplayValue("Today system");

		expect(pendingProfileRun?.signal.aborted).toBe(true);
		await act(async () => {
			pendingProfileRun?.resolve(
				jsonResponse(profilePlaygroundResponse("stale Analyse output")),
			);
		});

		expect(screen.queryByText("stale Analyse output")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
	});

	it("configures providers, fetches models, and saves AI and language settings", async () => {
		const savedBodies: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/config" && init?.method !== "POST") {
					return jsonResponse({
						ok: true,
						ai: { provider: "", baseUrl: "", apiKey: "", model: "" },
						language: { aiLanguage: "", uiLanguage: "" },
					});
				}
				if (url.pathname === "/api/digest-schedule") {
					return jsonResponse(scheduleResponse());
				}
				if (url.pathname === "/api/config-models") {
					return jsonResponse({ ok: true, models: ["model-a", "model-b"] });
				}
				if (url.pathname === "/api/config" && init?.method === "POST") {
					savedBodies.push(JSON.parse(String(init.body)));
					return jsonResponse(configResponse());
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<ConfigRoute />);
		const provider = await screen.findByRole("combobox");
		const baseUrl = screen.getByPlaceholderText("https://api.openai.com/v1");
		const apiKey = screen.getByPlaceholderText("sk-...");
		const model = screen.getByPlaceholderText("gpt-4o");

		fireEvent.change(provider, { target: { value: "deepseek" } });
		expect(baseUrl).toHaveValue("https://api.deepseek.com/v1");
		expect(model).toHaveValue("deepseek-chat");
		fireEvent.change(provider, { target: { value: "openai" } });
		expect(baseUrl).toHaveValue("https://api.openai.com/v1");
		fireEvent.change(provider, { target: { value: "google" } });
		expect(baseUrl).toHaveValue(
			"https://generativelanguage.googleapis.com/v1beta/openai",
		);
		fireEvent.change(provider, { target: { value: "openrouter" } });
		expect(model).toHaveValue("google/gemini-2.5-flash");
		fireEvent.change(provider, { target: { value: "custom" } });

		fireEvent.change(baseUrl, { target: { value: "https://models.test/v1" } });
		fireEvent.change(apiKey, { target: { value: "secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Fetch Models" }));
		await screen.findByText(/Select Fetched Model \(2 models\)/u);
		const fetchedModels = screen.getAllByRole("combobox")[1];
		fireEvent.change(fetchedModels, { target: { value: "" } });
		fireEvent.change(fetchedModels, { target: { value: "model-b" } });
		expect(model).toHaveValue("model-b");

		fireEvent.click(screen.getByRole("button", { name: "Save Config" }));
		expect(
			await screen.findByText("Configuration saved successfully!"),
		).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "语言配置" }));
		const languages = screen.getAllByRole("combobox");
		fireEvent.change(languages[0], { target: { value: "en" } });
		fireEvent.change(languages[1], { target: { value: "en" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Config" }));
		await waitFor(() => expect(savedBodies).toHaveLength(2));
		expect(savedBodies[1]).toMatchObject({
			language: { aiLanguage: "en", uiLanguage: "en" },
		});
	});

	it("surfaces model, config load, and save errors and clears them across tabs", async () => {
		let modelAttempts = 0;
		let configLoads = 0;
		let rejectSchedule: ((error: Error) => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/config" && init?.method !== "POST") {
					configLoads += 1;
					throw new Error("config unavailable");
				}
				if (url.pathname === "/api/digest-schedule") {
					return new Promise<Response>((_resolve, reject) => {
						rejectSchedule = reject;
					});
				}
				if (url.pathname === "/api/config-models") {
					modelAttempts += 1;
					if (modelAttempts === 1) {
						return jsonResponse({ ok: false, error: "provider rejected" });
					}
					throw new Error("model network failed");
				}
				if (url.pathname === "/api/config" && init?.method === "POST") {
					throw new Error("save rejected");
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<ConfigRoute />);
		expect(await screen.findByText("config unavailable")).toBeVisible();
		expect(configLoads).toBe(1);
		fireEvent.click(screen.getByRole("button", { name: "语言配置" }));
		expect(screen.queryByText("config unavailable")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "模型配置" }));

		fireEvent.change(screen.getByPlaceholderText("https://api.openai.com/v1"), {
			target: { value: "https://models.test/v1" },
		});
		fireEvent.change(screen.getByPlaceholderText("sk-..."), {
			target: { value: "secret" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Fetch Models" }));
		expect(await screen.findByText("provider rejected")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Fetch Models" }));
		expect(await screen.findByText("model network failed")).toBeVisible();

		fireEvent.change(screen.getByPlaceholderText("gpt-4o"), {
			target: { value: "model-a" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save Config" }));
		expect(await screen.findByText("save rejected")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "摘要归档调度" }));
		await act(async () => {
			rejectSchedule?.(new Error("schedule unavailable"));
		});
		expect(await screen.findByText("schedule unavailable")).toBeVisible();
	});

	it("edits and saves digest archive schedule settings", async () => {
		const scheduleBodies: unknown[] = [];
		let scheduleSaves = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/config") {
					return jsonResponse(configResponse());
				}
				if (
					url.pathname === "/api/digest-schedule" &&
					init?.method !== "POST"
				) {
					return jsonResponse(scheduleResponse());
				}
				if (
					url.pathname === "/api/digest-schedule" &&
					init?.method === "POST"
				) {
					scheduleSaves += 1;
					scheduleBodies.push(JSON.parse(String(init.body)));
					if (scheduleSaves === 2) throw new Error("schedule save failed");
					return jsonResponse(scheduleResponse());
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		const view = render(<ConfigRoute />);
		fireEvent.click(
			await screen.findByRole("button", { name: "摘要归档调度" }),
		);
		const timeInputs =
			view.container.querySelectorAll<HTMLInputElement>('input[type="time"]');
		for (const [index, value] of [
			"09:10",
			"10:20",
			"11:30",
			"12:40",
		].entries()) {
			fireEvent.change(timeInputs[index], { target: { value } });
		}
		fireEvent.change(
			screen.getByPlaceholderText("~/.birdclaw/digest-archive"),
			{
				target: { value: "/tmp/digests" },
			},
		);
		fireEvent.click(screen.getByRole("button", { name: "Save Config" }));
		expect(await screen.findByText("调度已保存并生效。")).toBeVisible();
		expect(scheduleBodies[0]).toEqual({
			archiveDir: "/tmp/digests",
			schedule: {
				today: { hour: 9, minute: 10 },
				"24h": { hour: 10, minute: 20 },
				yesterday: { hour: 11, minute: 30 },
				week: { hour: 12, minute: 40 },
			},
		});

		fireEvent.click(screen.getByRole("button", { name: "Save Config" }));
		expect(await screen.findByText("schedule save failed")).toBeVisible();
	});

	it("renders defaults when config and schedule responses are not active", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname === "/api/config") {
					return jsonResponse({ ...configResponse(), ok: false });
				}
				if (url.pathname === "/api/digest-schedule") {
					return jsonResponse({ ...scheduleResponse(), ok: false });
				}
				throw new Error(`Unexpected request: ${url.pathname}`);
			}),
		);

		render(<ConfigRoute />);
		expect(await screen.findByRole("combobox")).toHaveValue("openai");
		fireEvent.click(screen.getByRole("button", { name: "摘要归档调度" }));
		expect(screen.getByDisplayValue("08:00")).toBeVisible();
	});
});
