# Issue #54 Action 1 Archive Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject malformed digest archive requests and prevent archive path construction from escaping the configured archive directory without changing valid archive behavior.

**Architecture:** Put the public query contract in one focused `digest-archive-request` module shared by both archive routes. Keep filesystem defense in `resolveDigestArchivePaths`, using `path.relative` only as a containment check while preserving the existing returned path strings for valid callers.

**Tech Stack:** TypeScript 7, Effect, TanStack Start route handlers, Node.js `path`, Vitest.

---

## File Map

- Create `src/lib/digest-archive-request.ts`: parse and validate the public archive period, content source, and date query parameters.
- Modify `src/routes/api/digest-archive-entry.tsx`: use the shared entry-request parser and map validation failures to HTTP 400.
- Modify `src/routes/api/digest-archive-entry.test.ts`: cover defaults, invalid values, real calendar dates, and traversal rejection at the route boundary.
- Modify `src/routes/api/digest-archive-dates.tsx`: use the shared period parser and map validation failures to HTTP 400.
- Modify `src/routes/api/digest-archive-dates.test.ts`: cover the omitted default and unknown-period rejection.
- Modify `src/lib/digest-archive-job.ts`: add lexical containment to `resolveDigestArchivePaths` without changing valid path output.
- Modify `src/lib/digest-archive-job.test.ts`: prove valid path compatibility and reject parent, sibling-prefix, and absolute escapes.

### Task 1: Share Strict Archive Request Validation Across Both Routes

**Files:**

- Create: `src/lib/digest-archive-request.ts`
- Modify: `src/routes/api/digest-archive-entry.test.ts`
- Modify: `src/routes/api/digest-archive-entry.tsx`
- Modify: `src/routes/api/digest-archive-dates.test.ts`
- Modify: `src/routes/api/digest-archive-dates.tsx`

- [ ] **Step 1: Add failing archive-entry route tests**

Append tests that prove omitted values retain their defaults, valid leap days
reach the reader, and every invalid value fails before archive directory
resolution or file access:

```ts
it("defaults omitted period and content source for a valid archive date", async () => {
	resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
	readDigestArchiveEntryEffectMock.mockResolvedValue(null);

	const response = await GET({
		request: new Request(
			"http://localhost/api/digest-archive-entry?date=2024-02-29",
		),
	});

	expect(response.status).toBe(200);
	expect(readDigestArchiveEntryEffectMock).toHaveBeenCalledWith({
		archiveDir: "/tmp/archive",
		period: "yesterday",
		contentSource: "all",
		date: "2024-02-29",
	});
});

it.each([
	[
		"unknown period",
		"period=month&contentSource=all&date=2026-07-21",
		"Archive period must be yesterday or week.",
	],
	[
		"unknown content source",
		"period=yesterday&contentSource=private&date=2026-07-21",
		"Archive contentSource must be all, following, or for_you.",
	],
	[
		"missing date",
		"period=yesterday&contentSource=all",
		"Archive date must be a real date in YYYY-MM-DD format.",
	],
	[
		"non-padded date",
		"period=yesterday&contentSource=all&date=2026-7-21",
		"Archive date must be a real date in YYYY-MM-DD format.",
	],
	[
		"impossible date",
		"period=yesterday&contentSource=all&date=2026-02-30",
		"Archive date must be a real date in YYYY-MM-DD format.",
	],
	[
		"year zero",
		"period=yesterday&contentSource=all&date=0000-01-01",
		"Archive date must be a real date in YYYY-MM-DD format.",
	],
	[
		"path traversal",
		`period=yesterday&contentSource=all&date=${encodeURIComponent("../../outside")}`,
		"Archive date must be a real date in YYYY-MM-DD format.",
	],
] as const)("rejects %s", async (_label, query, error) => {
	resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
	readDigestArchiveEntryEffectMock.mockResolvedValue(null);

	const response = await GET({
		request: new Request(`http://localhost/api/digest-archive-entry?${query}`),
	});

	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ ok: false, error });
	expect(resolveDigestArchiveDirMock).not.toHaveBeenCalled();
	expect(readDigestArchiveEntryEffectMock).not.toHaveBeenCalled();
});
```

Keep the existing `today`/`24h` table test unchanged so its specific error
message remains part of the contract.

- [ ] **Step 2: Add failing archive-dates route tests**

Append the omitted-period compatibility test and unknown-period rejection:

```ts
it("defaults an omitted period to yesterday", async () => {
	resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
	listDigestArchiveDatesEffectMock.mockResolvedValue([]);

	const response = await GET({
		request: new Request("http://localhost/api/digest-archive-dates"),
	});

	expect(response.status).toBe(200);
	expect(listDigestArchiveDatesEffectMock).toHaveBeenCalledWith({
		archiveDir: "/tmp/archive",
		period: "yesterday",
	});
});

it("rejects an unknown period before listing archives", async () => {
	resolveDigestArchiveDirMock.mockReturnValue("/tmp/archive");
	listDigestArchiveDatesEffectMock.mockResolvedValue([]);

	const response = await GET({
		request: new Request(
			"http://localhost/api/digest-archive-dates?period=month",
		),
	});

	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({
		ok: false,
		error: "Archive period must be yesterday or week.",
	});
	expect(resolveDigestArchiveDirMock).not.toHaveBeenCalled();
	expect(listDigestArchiveDatesEffectMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run both route tests and verify RED**

Run:

```bash
pnpm test src/routes/api/digest-archive-entry.test.ts src/routes/api/digest-archive-dates.test.ts
```

Expected: the new invalid-input cases fail because the current routes silently
map unknown values to defaults and pass unchecked dates to the archive reader.
The existing valid and current-view tests remain green.

- [ ] **Step 4: Create the shared request-validation module**

Create `src/lib/digest-archive-request.ts` with this complete contract:

```ts
import type { PeriodDigestContentSource } from "./period-digest";

export type DigestArchivePeriod = "yesterday" | "week";

const CURRENT_VIEW_ERROR =
	"Today and 24h are current views and do not have archives.";
const INVALID_PERIOD_ERROR = "Archive period must be yesterday or week.";
const INVALID_CONTENT_SOURCE_ERROR =
	"Archive contentSource must be all, following, or for_you.";
const INVALID_DATE_ERROR =
	"Archive date must be a real date in YYYY-MM-DD format.";

export function parseDigestArchivePeriod(
	value: string | null,
): DigestArchivePeriod {
	if (value === null) return "yesterday";
	if (value === "yesterday" || value === "week") return value;
	if (value === "today" || value === "24h") {
		throw new Error(CURRENT_VIEW_ERROR);
	}
	throw new Error(INVALID_PERIOD_ERROR);
}

export function parseDigestArchiveContentSource(
	value: string | null,
): PeriodDigestContentSource {
	if (value === null) return "all";
	if (value === "all" || value === "following" || value === "for_you") {
		return value;
	}
	throw new Error(INVALID_CONTENT_SOURCE_ERROR);
}

export function parseDigestArchiveDate(value: string | null): string {
	if (value === null || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		throw new Error(INVALID_DATE_ERROR);
	}
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (
		value.startsWith("0000-") ||
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== value
	) {
		throw new Error(INVALID_DATE_ERROR);
	}
	return value;
}

export function parseDigestArchiveEntryRequest(url: URL) {
	return {
		period: parseDigestArchivePeriod(url.searchParams.get("period")),
		contentSource: parseDigestArchiveContentSource(
			url.searchParams.get("contentSource"),
		),
		date: parseDigestArchiveDate(url.searchParams.get("date")),
	};
}
```

- [ ] **Step 5: Replace private parsing in the archive-entry route**

Remove the local `parsePeriod`, `currentPeriodError`, and `parseContentSource`
functions and the now-unused `PeriodDigestContentSource` type import. Import
the shared entry parser:

```ts
import { parseDigestArchiveEntryRequest } from "#/lib/digest-archive-request";
```

Replace the query parsing block with:

```ts
const url = new URL(request.url);
let options: ReturnType<typeof parseDigestArchiveEntryRequest>;
try {
	options = parseDigestArchiveEntryRequest(url);
} catch (error) {
	return jsonResponse(
		{
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		},
		{ status: 400 },
	);
}
const archiveDir = resolveDigestArchiveDir();
const entry = yield* readDigestArchiveEntryEffect({
	archiveDir,
	...options,
});
```

Leave the successful result mapping and the `200`/`result: null` branch
unchanged.

- [ ] **Step 6: Replace private parsing in the archive-dates route**

Remove the local `parsePeriod` and `currentPeriodError` functions. Import:

```ts
import { parseDigestArchivePeriod } from "#/lib/digest-archive-request";
```

Replace the period parsing block with:

```ts
const url = new URL(request.url);
let period: ReturnType<typeof parseDigestArchivePeriod>;
try {
	period = parseDigestArchivePeriod(url.searchParams.get("period"));
} catch (error) {
	return jsonResponse(
		{
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		},
		{ status: 400 },
	);
}
const archiveDir = resolveDigestArchiveDir();
```

Leave the archive listing call and successful response unchanged.

- [ ] **Step 7: Run route tests and verify GREEN**

Run:

```bash
pnpm test src/routes/api/digest-archive-entry.test.ts src/routes/api/digest-archive-dates.test.ts
```

Expected: both files pass, including defaults, valid dates, invalid values, and
the preserved current-view message.

- [ ] **Step 8: Commit strict request validation**

```bash
git add src/lib/digest-archive-request.ts \
  src/routes/api/digest-archive-entry.tsx \
  src/routes/api/digest-archive-entry.test.ts \
  src/routes/api/digest-archive-dates.tsx \
  src/routes/api/digest-archive-dates.test.ts
git commit -m "fix: validate digest archive requests"
```

### Task 2: Contain Archive Paths at the Filesystem Boundary

**Files:**

- Modify: `src/lib/digest-archive-job.test.ts`
- Modify: `src/lib/digest-archive-job.ts`

- [ ] **Step 1: Add failing path containment tests**

Add a focused describe block near the start of `digest-archive-job.test.ts`:

```ts
describe("resolveDigestArchivePaths", () => {
	it("preserves path construction for valid callers", () => {
		const archiveDir = path.join("relative", "archive");

		expect(
			resolveDigestArchivePaths({
				archiveDir,
				runDate: "2026-07-21",
				period: "yesterday",
				contentSource: "all",
			}),
		).toEqual({
			markdownPath: path.join(
				archiveDir,
				"2026-07-21",
				"yesterday-all.md",
			),
			jsonPath: path.join(
				archiveDir,
				"2026-07-21",
				"yesterday-all.json",
			),
		});
	});

	it.each([
		["parent", "../outside"],
		["nested parent", "../../outside"],
		["sibling with the same prefix", "../archive-other"],
		["absolute", path.resolve(path.sep, "outside")],
	] as const)("rejects a %s escape", (_label, runDate) => {
		expect(() =>
			resolveDigestArchivePaths({
				archiveDir: path.join("relative", "archive"),
				runDate,
				period: "yesterday",
				contentSource: "all",
			}),
		).toThrow("Archive path escapes archive directory");
	});
});
```

- [ ] **Step 2: Run the path tests and verify RED**

Run:

```bash
pnpm test src/lib/digest-archive-job.test.ts -t "resolveDigestArchivePaths"
```

Expected: the valid case passes and all escape cases fail because the current
function returns paths without a containment check.

- [ ] **Step 3: Add lexical containment without changing valid output**

Replace the body of `resolveDigestArchivePaths` with:

```ts
const root = path.resolve(archiveDir);
const candidate = path.resolve(root, runDate);
const relative = path.relative(root, candidate);
if (
	relative === ".." ||
	relative.startsWith(`..${path.sep}`) ||
	path.isAbsolute(relative)
) {
	throw new Error("Archive path escapes archive directory");
}

const base = path.join(archiveDir, runDate, `${period}-${contentSource}`);
return { markdownPath: `${base}.md`, jsonPath: `${base}.json` };
```

The check uses resolved absolute paths, but the returned `base` intentionally
keeps the original `path.join` expression so relative archive directories and
all valid file names stay byte-for-byte compatible.

- [ ] **Step 4: Run path and route tests and verify GREEN**

Run:

```bash
pnpm test src/lib/digest-archive-job.test.ts -t "resolveDigestArchivePaths"
pnpm test src/routes/api/digest-archive-entry.test.ts src/routes/api/digest-archive-dates.test.ts
```

Expected: both commands pass with zero failed tests.

- [ ] **Step 5: Commit path containment**

```bash
git add src/lib/digest-archive-job.ts src/lib/digest-archive-job.test.ts
git commit -m "fix: contain digest archive paths"
```

### Task 3: Run the Full Quality Gate

**Files:**

- Verify only; no planned source changes.

- [ ] **Step 1: Run all action 1 regression tests together**

```bash
pnpm test src/lib/digest-archive-job.test.ts src/routes/api/digest-archive-entry.test.ts src/routes/api/digest-archive-dates.test.ts
```

Expected: all three test files pass with zero failed tests.

- [ ] **Step 2: Run formatting, lint, and type checking**

```bash
pnpm check
```

Expected: `format:check`, `lint`, and `typecheck` all exit successfully with no
warnings promoted to errors.

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: every Vitest file and test passes.

- [ ] **Step 4: Run the production build**

```bash
pnpm build
```

Expected: the Vite application and CLI build both exit successfully.

- [ ] **Step 5: Inspect final scope and whitespace**

```bash
git status --short --branch
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
```

Expected: the branch contains the design/plan documentation and action 1 code
only, with no whitespace errors or unrelated files.
