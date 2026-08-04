# Issue 44 Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #44 by restoring the local worktree ignore rule, documenting the prompt-template parser contract, and raising measured branch coverage above 81% while leaving the configured threshold at 80%.

**Architecture:** Keep runtime behavior unchanged. Apply the repository and documentation fixes directly, then cover the two largest reachable user-facing gaps with route-component tests that use real rendering and mock only HTTP, router, and long-running stream boundaries.

**Tech Stack:** Git ignore rules, Markdown, React 19, TanStack React Query, Testing Library, Vitest 4 with V8 coverage.

---

### Task 1: Restore Repository and Prompt Documentation Contracts

**Files:**
- Modify: `.gitignore`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Restore the local worktree ignore rule**

Insert the following line after `.playwright-home-*`:

```gitignore
.worktrees/
```

- [ ] **Step 2: Verify the ignore rule**

Run:

```bash
git check-ignore -v .worktrees/example
```

Expected: output identifies `.gitignore` and the `.worktrees/` pattern.

- [ ] **Step 3: Document all prompt parser constraints**

After the prompt-template example in `docs/configuration.md`, add this paragraph:

```markdown
The schema declaration must be the first line of the file, with no heading or
blank line before it, and Birdclaw currently accepts only schema version 1.
Both the system and requirements sections must contain non-whitespace text;
empty sections are rejected.
```

- [ ] **Step 4: Verify the documentation text and formatting**

Run:

```bash
rg -n "first line|only schema version 1|non-whitespace" docs/configuration.md
git diff --check -- .gitignore docs/configuration.md
```

Expected: all three parser constraints are found and the diff check exits 0.

- [ ] **Step 5: Commit the repository and documentation fixes**

```bash
git add .gitignore docs/configuration.md
git commit -m "docs: close issue 44 repository gaps"
```

### Task 2: Record the Strict Coverage Failure and Cover Data Sources

**Files:**
- Create: `src/routes/data-sources.test.tsx`

- [ ] **Step 1: Run the temporary strict coverage gate and verify RED**

Run outside the network sandbox because production-server tests bind a local
loopback port:

```bash
pnpm coverage --coverage.thresholds.branches=81 --coverage.reporter=text-summary
```

Expected: all tests pass, but Vitest exits non-zero because branch coverage is
approximately 80.19%, below the temporary 81% override.

- [ ] **Step 2: Add Data Sources behavior tests**

Create `src/routes/data-sources.test.tsx` with a real Query Client wrapper and
the following cases:

```tsx
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient as render } from "#/test/render";
import { Route } from "./data-sources";

const DataSourcesRoute = Route.options.component as ComponentType;

function snapshot(detail = "local database ready") {
	return {
		generatedAt: "2026-08-04T00:00:00.000Z",
		sources: [
			{
				source: "birdclaw",
				label: "Birdclaw",
				works: true,
				status: "ok",
				detail,
				accounts: [
					{ app: "archive", username: "alice", isDefault: true },
					{ id: "acct_local" },
				],
			},
			{
				source: "bird",
				label: "bird CLI",
				works: false,
				status: "warning",
				detail: "authentication needed",
				accounts: [{ handle: "@bob" }],
			},
			{
				source: "xurl",
				label: "xurl",
				works: false,
				installed: false,
				status: "error",
				detail: "missing binary",
				accounts: [],
			},
		],
		capabilities: [
			{
				key: "profile",
				label: "Profile lookup",
				primary: "birdclaw",
				fallbacks: ["bird", "xurl"],
				notes: "Uses local data first",
			},
		],
	};
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("data sources route", () => {
	it("renders source health, accounts, and fallback order", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot())));

		render(<DataSourcesRoute />);

		expect(screen.getByText("Checking data sources...")).toBeInTheDocument();
		expect(await screen.findByText("local database ready")).toBeVisible();
		expect(screen.getByText("works")).toBeVisible();
		expect(screen.getByText("warning")).toBeVisible();
		expect(screen.getByText("not installed")).toBeVisible();
		expect(screen.getByText("archive")).toBeVisible();
		expect(screen.getByText("@alice")).toBeVisible();
		expect(screen.getByText("acct_local")).toBeVisible();
		expect(screen.getByText("default")).toBeVisible();
		expect(screen.getByText("no authenticated account detected")).toBeVisible();
		expect(screen.getByText("Profile lookup")).toBeVisible();
		expect(screen.getByText("Uses local data first")).toBeVisible();
		expect(screen.getByText("primary")).toBeVisible();
		expect(screen.getByText("fallback 1")).toBeVisible();
		expect(screen.getByText("fallback 2")).toBeVisible();
	});

	it("refreshes the snapshot and disables refresh while fetching", async () => {
		let resolveRefresh: ((response: Response) => void) | undefined;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(snapshot()))
			.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						resolveRefresh = resolve;
					}),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<DataSourcesRoute />);
		await screen.findByText("local database ready");
		const refresh = screen.getByRole("button", { name: "Refresh" });
		fireEvent.click(refresh);
		await waitFor(() => expect(refresh).toBeDisabled());
		resolveRefresh?.(Response.json(snapshot("refreshed")));

		expect(await screen.findByText("refreshed")).toBeVisible();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("shows request errors without rendering a snapshot", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("status offline")));

		render(<DataSourcesRoute />);

		expect(await screen.findByText("status offline")).toBeVisible();
		expect(screen.queryByText("Fallbacks")).not.toBeInTheDocument();
	});
});
```

- [ ] **Step 3: Run the focused Data Sources suite**

Run:

```bash
pnpm test src/routes/data-sources.test.tsx
```

Expected: 3 tests pass with no warnings.

- [ ] **Step 4: Commit the Data Sources coverage**

```bash
git add src/routes/data-sources.test.tsx
git commit -m "test: cover data sources route states"
```

### Task 3: Cover Profile Analyse and Turn the Strict Gate GREEN

**Files:**
- Create: `src/routes/profile-analyze.test.tsx`

- [ ] **Step 1: Add Profile Analyse route behavior tests**

Create `src/routes/profile-analyze.test.tsx`. Preserve the real exported
helpers and status component while replacing only the streaming hook:

```tsx
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileAnalysisState } from "#/components/ProfileAnalysisStream";
import { renderWithQueryClient as render } from "#/test/render";

let analysisState: ProfileAnalysisState;
const runAnalysis = vi.fn();

vi.mock("#/components/ProfileAnalysisStream", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("#/components/ProfileAnalysisStream")
	>();
	return { ...actual, useProfileAnalysisStream: () => analysisState };
});

import { Route } from "./profile-analyze";

const ProfileAnalyzeRoute = Route.options.component as ComponentType;
const navigate = vi.fn();

function baseAnalysis(
	overrides: Partial<ProfileAnalysisState> = {},
): ProfileAnalysisState {
	return {
		context: null,
		error: null,
		loading: false,
		markdown: "",
		result: null,
		run: runAnalysis,
		status: "Ready",
		...overrides,
	};
}

function installRoute(handle: string) {
	vi.spyOn(Route, "useSearch").mockReturnValue({ handle } as never);
	vi.spyOn(Route, "useNavigate").mockReturnValue(navigate as never);
}

function installFetch(metadata: Record<string, unknown>) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		if (url.pathname === "/api/status") {
			return Response.json({ accounts: [{ id: "acct_primary", handle: "me" }] });
		}
		if (url.pathname === "/api/config") {
			return Response.json({
				ok: true,
				language: { aiLanguage: "en", uiLanguage: "en" },
			});
		}
		if (url.pathname === "/api/profile-analysis-metadata") {
			return Response.json({ ok: true, ...metadata });
		}
		if (url.pathname === "/api/avatar") {
			return new Response(null, { status: 404 });
		}
		throw new Error(`Unexpected request: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	analysisState = baseAnalysis();
	runAnalysis.mockReset();
	navigate.mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("profile analyse route", () => {
	it("loads landing metadata and navigates to a selected profile", async () => {
		installRoute("");
		installFetch({
			anyActive: false,
			analyzed: [
				{
					id: "profile_alice",
					handle: "alice",
					displayName: "Alice",
					lastAnalyzedAt: "2026-08-03T00:00:00.000Z",
				},
			],
			following: [
				{ id: "profile_bob", handle: "bob", displayName: "Bob" },
			],
		});

		render(<ProfileAnalyzeRoute />);

		expect(await screen.findByText("Alice")).toBeVisible();
		expect(screen.getByText("Bob")).toBeVisible();
		fireEvent.click(screen.getByText("Alice"));
		expect(navigate).toHaveBeenCalledWith({ search: { handle: "alice" } });
	});

	it("renders a saved snapshot and returns to the current report", async () => {
		installRoute("@alice");
		installFetch({
			anyActive: false,
			isAnalyzing: false,
			activeStatus: null,
			snapshots: [
				{
					cacheKey: "snapshot_1",
					updatedAt: "2026-08-03T12:00:00.000Z",
					model: "openai/gpt-test",
					markdown: "# Analysis for @alice\n\nSnapshot body",
				},
			],
		});

		render(<ProfileAnalyzeRoute />);

		expect(await screen.findByText("Snapshot body")).toBeVisible();
		expect(screen.queryByText("Analysis for @alice")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "返回最新分析" }));
		expect(screen.getByText("Preparing @alice.")).toBeVisible();

		fireEvent.change(screen.getAllByRole("combobox")[0], {
			target: { value: "zh-CN" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(runAnalysis).toHaveBeenCalledWith(true);
	});

	it("shows active analysis status and blocks a competing analysis", async () => {
		installRoute("bob");
		installFetch({
			anyActive: true,
			isAnalyzing: false,
			activeStatus: null,
			snapshots: [],
		});

		render(<ProfileAnalyzeRoute />);

		expect(
			await screen.findByText(/有分析任务执行中/u),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: /生成画像分析/u }),
		).toBeDisabled();
	});

	it("renders background analysis status", async () => {
		installRoute("carol");
		installFetch({
			anyActive: true,
			isAnalyzing: true,
			activeStatus: { label: "Summarizing", detail: "profile" },
			snapshots: [],
		});

		render(<ProfileAnalyzeRoute />);
		expect(await screen.findByText("Summarizing · profile")).toBeVisible();
		expect(screen.getByText(/后台画像拉取与总结中/u)).toBeVisible();
	});

	it("renders live markdown together with a stream error", async () => {
		analysisState = baseAnalysis({
			error: "analysis offline",
			markdown: "## Live report",
			status: "Complete",
		});
		installRoute("carol");
		installFetch({
			anyActive: false,
			isAnalyzing: false,
			activeStatus: null,
			snapshots: [],
		});
		render(<ProfileAnalyzeRoute />);

		expect(await screen.findByText("analysis offline")).toBeVisible();
		expect(screen.getByText("Live report")).toBeVisible();
	});
});
```

- [ ] **Step 2: Run the focused Profile Analyse suite**

Run:

```bash
pnpm test src/routes/profile-analyze.test.tsx
```

Expected: 5 tests pass with no React state-update or unhandled-request warnings.

- [ ] **Step 3: Run the temporary strict coverage gate and verify GREEN**

Run outside the network sandbox:

```bash
pnpm coverage --coverage.thresholds.branches=81 --coverage.reporter=text-summary
```

Expected: all tests pass, global branch coverage is at least 81%, and the
command exits 0. Do not change `vitest.config.ts`; its branch threshold remains
80.

- [ ] **Step 4: Commit the Profile Analyse coverage**

```bash
git add src/routes/profile-analyze.test.tsx
git commit -m "test: add branch coverage headroom"
```

### Task 4: Cross-Version and Full Verification

**Files:**
- Verify only; no source changes expected.

- [ ] **Step 1: Verify focused route tests together**

```bash
pnpm test src/routes/data-sources.test.tsx src/routes/profile-analyze.test.tsx
```

Expected: all 8 focused tests pass.

- [ ] **Step 2: Verify the ordinary configured coverage command**

Run outside the network sandbox:

```bash
pnpm coverage
```

Expected: all tests pass and global branch coverage is at least 81%, while the
reported configured threshold remains 80%.

- [ ] **Step 3: Verify with pinned Node 26.5.0**

Install Node 26.5.0 through the existing local nvm installation if it is not
already present, then run:

```bash
zsh -lc 'source /Users/friendfish/.nvm/nvm.sh && nvm exec 26.5.0 pnpm coverage --coverage.thresholds.branches=81 --coverage.reporter=text-summary'
```

Expected: Node 26.5.0 runs all tests successfully and reports global branch
coverage of at least 81%.

- [ ] **Step 4: Run the repository release gate**

```bash
pnpm run check
pnpm test
pnpm run build
git diff --check HEAD~3..HEAD
git status --short
```

Expected: check, tests, and build exit 0; diff check is clean; status contains
no uncommitted implementation files.

- [ ] **Step 5: Review the final change against issue #44**

Confirm all of the following from fresh command output:

```text
.worktrees/ is ignored
all three prompt parser constraints are documented
Vitest branch threshold is still 80
actual branch coverage is at least 81 on Node 24 and Node 26.5
focused tests, full tests, checks, and build pass
```
