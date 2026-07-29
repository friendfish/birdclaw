import {
	installAccountSyncLaunchAgent,
	parseAccountSyncSteps,
	runAccountSyncJob,
} from "#/lib/account-sync-job";
import {
	installBookmarkSyncLaunchAgent,
	runBookmarkSyncJob,
} from "#/lib/bookmark-sync-job";
import {
	installAllDigestArchiveLaunchAgents,
	installDigestArchiveLaunchAgent,
	parseDigestContentSources,
	runDigestArchiveJob,
} from "#/lib/digest-archive-job";
import type { PeriodDigestPreset } from "#/lib/period-digest";
import type { TimelineCollectionMode } from "#/lib/timeline-collections-live";
import type { CliCommandContext } from "./command-context";

function parsePeriod(value: string): PeriodDigestPreset {
	if (
		value === "today" ||
		value === "yesterday" ||
		value === "24h" ||
		value === "week"
	) {
		return value;
	}
	throw new Error("--period must be today, yesterday, 24h, or week");
}

export function registerJobCommands({ program, print }: CliCommandContext) {
	const jobsCommand = program
		.command("jobs")
		.description("Run and install background Birdclaw jobs");

	jobsCommand
		.command("sync-account")
		.description(
			"Refresh live account timelines and append a JSONL audit entry",
		)
		.option("--account <username>", "Account username or id")
		.option(
			"--steps <steps>",
			"Comma list: timeline,mentions,mention-threads,likes,bookmarks,dms",
		)
		.option("--mode <mode>", "auto, xurl, or bird for likes/bookmarks")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--max-pages <n>", "Stop after N pages", "3")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.option(
			"--allow-bird-account",
			"Assert bird cookies match --account for Bird-backed steps",
		)
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runAccountSyncJob({
				account: options.account,
				steps: parseAccountSyncSteps(options.steps),
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				maxPages: Number(options.maxPages),
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
				allowBirdAccount: Boolean(options.allowBirdAccount),
				logPath: options.log,
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-account-launchd")
		.description("Install a LaunchAgent that runs account sync")
		.option("--label <label>", "LaunchAgent label")
		.option("--interval-seconds <seconds>", "Launch interval", "1800")
		.option("--program <path>", "birdclaw executable or command", "birdclaw")
		.option("--account <username>", "Account username or id")
		.option(
			"--steps <steps>",
			"Comma list: timeline,mentions,mention-threads,likes,bookmarks,dms",
		)
		.option("--mode <mode>", "auto, xurl, or bird for likes/bookmarks")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--max-pages <n>", "Stop after N pages", "3")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--no-refresh", "Allow live-cache reuse")
		.option(
			"--allow-bird-account",
			"Assert bird cookies match --account for Bird-backed steps",
		)
		.option("--log <path>", "Audit JSONL path")
		.option("--env-path <path>", "Shell env file to source before running")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			const result = await installAccountSyncLaunchAgent({
				label: options.label,
				intervalSeconds: Number(options.intervalSeconds),
				program: options.program,
				account: options.account,
				steps: parseAccountSyncSteps(options.steps),
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				maxPages: Number(options.maxPages),
				refresh: options.refresh,
				allowBirdAccount: Boolean(options.allowBirdAccount),
				cacheTtlSeconds: Number(options.cacheTtl),
				logPath: options.log,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			});
			print(result, true);
		});

	jobsCommand
		.command("sync-bookmarks")
		.description("Refresh live bookmarks and append a JSONL audit entry")
		.option("--account <username>", "Account username or id")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runBookmarkSyncJob({
				account: options.account,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.all ? undefined : Number(options.maxPages),
				refresh: Boolean(options.refresh),
				cacheTtlMs: Number(options.cacheTtl) * 1000,
				logPath: options.log,
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-bookmarks-launchd")
		.description("Install a LaunchAgent that runs bookmark sync every 3 hours")
		.option("--account <username>", "Account username or id")
		.option("--label <label>", "LaunchAgent label")
		.option("--interval-seconds <seconds>", "Launch interval", "10800")
		.option("--program <path>", "birdclaw executable or command", "birdclaw")
		.option("--mode <mode>", "auto, xurl, or bird", "auto")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--no-refresh", "Allow live-cache reuse")
		.option("--log <path>", "Audit JSONL path")
		.option("--env-path <path>", "Shell env file to source before running")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			const result = await installBookmarkSyncLaunchAgent({
				account: options.account,
				label: options.label,
				intervalSeconds: Number(options.intervalSeconds),
				program: options.program,
				mode: options.mode as TimelineCollectionMode,
				limit: Number(options.limit),
				all: Boolean(options.all) || options.maxPages !== undefined,
				maxPages: options.all ? undefined : Number(options.maxPages),
				refresh: options.refresh,
				cacheTtlSeconds: Number(options.cacheTtl),
				logPath: options.log,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			});
			print(result, true);
		});

	jobsCommand
		.command("run-digest-archive")
		.description(
			"Generate and archive period digests (md+json) for all content sources",
		)
		.requiredOption("--period <period>", "today, yesterday, 24h, or week")
		.option("--account <username>", "Account username or id")
		.option("--include-dms", "Include DMs in the digest context")
		.option("--content-sources <sources>", "Comma list: all,following,for_you")
		.option("--archive-dir <path>", "Archive root directory")
		.option("--retries <n>", "Retries per content source", "2")
		.option("--retry-delay-seconds <seconds>", "Delay between retries", "120")
		.option("--log <path>", "Audit JSONL path")
		.option(
			"--since <iso>",
			"Backfill: explicit window start (overrides the period's normal now-relative window)",
		)
		.option("--until <iso>", "Backfill: explicit window end")
		.option(
			"--run-date <yyyy-mm-dd>",
			"Backfill: archive folder date (defaults to today)",
		)
		.option(
			"--no-live-sync",
			"Skip live X sync; summarize only what's already stored locally (for backfilling historical windows)",
		)
		.action(async (options) => {
			const runDate = options.runDate
				? new Date(`${options.runDate}T00:00:00`)
				: undefined;
			const result = await runDigestArchiveJob({
				period: parsePeriod(options.period),
				account: options.account,
				includeDms: Boolean(options.includeDms),
				contentSources: parseDigestContentSources(options.contentSources),
				archiveDir: options.archiveDir,
				retries: Number(options.retries),
				retryDelayMs: Number(options.retryDelaySeconds) * 1000,
				logPath: options.log,
				since: options.since,
				until: options.until,
				liveSync: Boolean(options.liveSync),
				...(runDate ? { now: () => runDate } : {}),
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-digest-archive-launchd")
		.description("Install LaunchAgent(s) that archive scheduled period digests")
		.option("--period <period>", "today, yesterday, 24h, week, or all", "all")
		.option("--hour <n>", "Hour (0-23); ignored when --period all")
		.option("--minute <n>", "Minute (0-59); ignored when --period all")
		.option("--weekday <n>", "0-7, Monday=1 (week only)")
		.option("--label <label>", "LaunchAgent label")
		.option("--program <path>", "birdclaw executable or command", "birdclaw")
		.option("--account <username>", "Account username or id")
		.option("--include-dms", "Include DMs in the digest context")
		.option("--content-sources <sources>", "Comma list: all,following,for_you")
		.option("--archive-dir <path>", "Archive root directory")
		.option("--retries <n>", "Retries per content source", "2")
		.option("--retry-delay-seconds <seconds>", "Delay between retries", "120")
		.option("--log <path>", "Audit JSONL path")
		.option("--env-path <path>", "Shell env file to source before running")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			// Fields that make sense applied identically to all 4 periods when
			// --period all is used. label/program/env/stdout/stderr are
			// per-period-only concerns (each agent needs its own label and log
			// files) and are only meaningful for a single-period install.
			const perPeriodOverrides = {
				account: options.account,
				includeDms: Boolean(options.includeDms),
				contentSources: parseDigestContentSources(options.contentSources),
				archiveDir: options.archiveDir,
				retries: Number(options.retries),
				retryDelaySeconds: Number(options.retryDelaySeconds),
				logPath: options.log,
			};
			const installOptions = {
				launchAgentsDir: options.launchAgentsDir,
				load: options.load,
			};
			if (options.period === "all") {
				const result = await installAllDigestArchiveLaunchAgents(
					{
						today: perPeriodOverrides,
						"24h": perPeriodOverrides,
						yesterday: perPeriodOverrides,
						week: perPeriodOverrides,
					},
					installOptions,
				);
				print(result, true);
				return;
			}
			const result = await installDigestArchiveLaunchAgent({
				period: parsePeriod(options.period),
				hour: options.hour === undefined ? undefined : Number(options.hour),
				minute:
					options.minute === undefined ? undefined : Number(options.minute),
				weekday:
					options.weekday === undefined ? undefined : Number(options.weekday),
				label: options.label,
				program: options.program,
				envFile: options.envPath ?? options.envFile,
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				...installOptions,
				...perPeriodOverrides,
			});
			print(result, true);
		});
}
