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
	installBookmarkExportLaunchAgent,
	runBookmarkExportJob,
} from "#/lib/bookmark-export-job";
import { isCalendarDateString } from "#/lib/calendar-date";
import {
	installAllDigestArchiveLaunchAgents,
	installDigestArchiveLaunchAgent,
	parseDigestContentSources,
	runDigestArchiveJob,
} from "#/lib/digest-archive-job";
import {
	resolveDigestLaunchdExecution,
	setDigestLaunchdExecution,
} from "#/lib/config";
import type { PeriodDigestPreset } from "#/lib/period-digest";
import {
	activatePeriodDigestFreshnessRetry,
	completePeriodDigestFreshnessAttempt,
	consumePeriodDigestFreshnessAttempt,
} from "#/lib/period-digest-freshness";
import {
	requestPeriodDigestRun,
	type PeriodDigestTrigger,
	type PeriodDigestTriggerOrigin,
} from "#/lib/period-digest-orchestrator";
import { resolveLiveSyncMode } from "#/lib/live-transport-policy";
import type { TimelineCollectionMode } from "#/lib/timeline-collections-live";
import { printError, type CliCommandContext } from "./command-context";

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

function parseCurrentPeriod(value: string): "today" | "24h" {
	const period = parsePeriod(value);
	if (period === "today" || period === "24h") return period;
	throw new Error("--period must be today or 24h");
}

function parseDigestTrigger(value: string): PeriodDigestTrigger {
	if (value === "scheduled" || value === "freshness" || value === "manual") {
		return value;
	}
	throw new Error("--trigger must be scheduled, freshness, or manual");
}

function parseDigestTriggerOrigin(value: string): PeriodDigestTriggerOrigin {
	if (value === "launchd" || value === "page" || value === "cli") return value;
	throw new Error("--origin must be launchd, page, or cli");
}

function parseOptionalJobMode(
	mode: string | undefined,
): TimelineCollectionMode | undefined {
	return mode === undefined ? undefined : resolveLiveSyncMode(mode);
}

function parseScheduleOverride(
	value: string | undefined,
	option: "--hour" | "--minute",
	maximum: number,
) {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		printError(`${option} must be an integer from 0 to ${String(maximum)}`);
		process.exitCode = 1;
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		printError(`${option} must be an integer from 0 to ${String(maximum)}`);
		process.exitCode = 1;
		return undefined;
	}
	return parsed;
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
			"--bird-credentials-path <path>",
			"Strict AUTH_TOKEN/CT0 credential file",
		)
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
				mode: parseOptionalJobMode(options.mode),
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
			"--bird-credentials-path <path>",
			"Strict AUTH_TOKEN/CT0 credential file",
		)
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
		.option("--env-path <path>", "Shell environment file to source")
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
				mode: parseOptionalJobMode(options.mode),
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
		.option("--mode <mode>", "auto, xurl, or bird")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--refresh", "Bypass live-cache freshness window")
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runBookmarkSyncJob({
				account: options.account,
				mode: parseOptionalJobMode(options.mode),
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
		.option("--mode <mode>", "auto, xurl, or bird")
		.option("--limit <n>", "Per-page/result limit", "100")
		.option("--all", "Fetch every retrievable page")
		.option("--max-pages <n>", "Stop after N pages", "5")
		.option("--cache-ttl <seconds>", "Live-cache freshness window", "120")
		.option("--no-refresh", "Allow live-cache reuse")
		.option("--log <path>", "Audit JSONL path")
		.option("--env-path <path>", "Shell environment file to source")
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
				mode: parseOptionalJobMode(options.mode),
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
		.command("export-bookmarks")
		.description("Export local bookmarks to Markdown and append a JSONL audit")
		.option("--account <username>", "Account username or id")
		.option("--archive-dir <path>", "Override the configured archive directory")
		.option("--full", "Re-render all current bookmark files")
		.option("--log <path>", "Audit JSONL path")
		.action(async (options) => {
			const result = await runBookmarkExportJob({
				account: options.account,
				archiveDir: options.archiveDir,
				full: Boolean(options.full),
				logPath: options.log,
			});
			print(result, true);
			if (!result.ok) process.exitCode = 1;
		});

	jobsCommand
		.command("install-bookmark-export-launchd")
		.description("Install a LaunchAgent that exports local bookmarks daily")
		.option("--account <username>", "Account username or id")
		.option("--archive-dir <path>", "Override the configured archive directory")
		.option("--full", "Re-render all current bookmark files on every run")
		.option("--hour <n>", "Hour (0-23); defaults to configuration")
		.option("--minute <n>", "Minute (0-59); defaults to configuration")
		.option("--label <label>", "LaunchAgent label")
		.option("--program <path>", "birdclaw executable or command", "birdclaw")
		.option("--log <path>", "Audit JSONL path")
		.option("--env-path <path>", "Shell environment file to source")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options) => {
			const hour = parseScheduleOverride(options.hour, "--hour", 23);
			const minute = parseScheduleOverride(options.minute, "--minute", 59);
			if (
				(options.hour !== undefined && hour === undefined) ||
				(options.minute !== undefined && minute === undefined)
			) {
				return;
			}
			const result = await installBookmarkExportLaunchAgent({
				account: options.account,
				archiveDir: options.archiveDir,
				full: Boolean(options.full),
				hour,
				minute,
				label: options.label,
				program: options.program,
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
		.command("activate-period-digest-freshness-retry", { hidden: true })
		.requiredOption("--period <period>", "today or 24h")
		.requiredOption("--attempt-token <token>", "Freshness attempt token")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.action(async (options) => {
			const period = parseCurrentPeriod(options.period);
			const result = await activatePeriodDigestFreshnessRetry({
				period,
				attemptToken: options.attemptToken,
				...(options.launchAgentsDir
					? {
							installOptions: {
								launchAgentsDir: options.launchAgentsDir,
							},
						}
					: {}),
			});
			print(
				{
					ok: result.state?.status !== "error",
					period,
					...result,
				},
				true,
			);
			if (result.state?.status === "error") process.exitCode = 1;
		});

	jobsCommand
		.command("run-period-digest")
		.description("Generate and publish the current Today or 24h digest batch")
		.requiredOption("--period <period>", "today or 24h")
		.option(
			"--trigger <trigger>",
			"scheduled, freshness, or manual",
			"scheduled",
		)
		.option("--origin <origin>", "launchd, page, or cli", "cli")
		.option(
			"--attempt-token <token>",
			"One-shot token for a freshness launchd wakeup",
		)
		.option(
			"--requested-source <source>",
			"Manual owner priority: all, following, or for_you",
		)
		.option("--account <username>", "Account username or id")
		.option(
			"--bird-credentials-path <path>",
			"Strict AUTH_TOKEN/CT0 credential file",
		)
		.option(
			"--no-live-sync",
			"Skip the batch pre-sync and use locally stored information",
		)
		.action(async (options) => {
			const period = parseCurrentPeriod(options.period);
			const trigger = parseDigestTrigger(options.trigger);
			const origin = parseDigestTriggerOrigin(options.origin);
			let freshnessAttemptToken: string | undefined;
			if (trigger === "freshness" && origin === "launchd") {
				if (!options.attemptToken) {
					throw new Error(
						"--attempt-token is required for freshness launchd wakeups",
					);
				}
				const attempt = await consumePeriodDigestFreshnessAttempt({
					period,
					attemptToken: options.attemptToken,
					origin: "launchd",
				});
				if (!attempt.valid) {
					print({ ok: true, skipped: attempt.reason, period }, true);
					return;
				}
				freshnessAttemptToken = options.attemptToken;
			}
			const requestedSource = options.requestedSource
				? parseDigestContentSources(options.requestedSource)?.[0]
				: undefined;
			let run;
			let state;
			try {
				run = await requestPeriodDigestRun({
					period,
					trigger,
					origin,
					...(requestedSource ? { requestedSource } : {}),
					...(options.account ? { account: options.account } : {}),
					...(options.birdCredentialsPath
						? { birdCredentialsPath: options.birdCredentialsPath }
						: {}),
					liveSync: Boolean(options.liveSync),
				});
				state = await run.completion;
			} catch (error) {
				if (freshnessAttemptToken) {
					await completePeriodDigestFreshnessAttempt({
						period,
						attemptToken: freshnessAttemptToken,
						origin,
						outcome: "failed",
					}).catch(() => undefined);
				}
				throw error;
			}
			if (freshnessAttemptToken) {
				await completePeriodDigestFreshnessAttempt({
					period,
					attemptToken: freshnessAttemptToken,
					origin,
					outcome: state.phase === "failed" ? "failed" : "published",
				});
			}
			print(
				{ ok: state.phase !== "failed", joined: run.joined, ...state },
				true,
			);
			if (state.phase === "failed") process.exitCode = 1;
		});

	jobsCommand
		.command("run-digest-archive")
		.description(
			"Generate current Today/24h digests or archive Yesterday/Week (md+json)",
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
		.option(
			"--bird-credentials-path <path>",
			"Strict AUTH_TOKEN/CT0 credential file",
		)
		.action(async (options, command) => {
			const period = parsePeriod(options.period);
			if (period === "today" || period === "24h") {
				const ignoredOptions = [
					["includeDms", "--include-dms"],
					["contentSources", "--content-sources"],
					["archiveDir", "--archive-dir"],
					["retries", "--retries"],
					["retryDelaySeconds", "--retry-delay-seconds"],
					["log", "--log"],
					["since", "--since"],
					["until", "--until"],
					["runDate", "--run-date"],
				]
					.filter(([key]) => command.getOptionValueSource(key) === "cli")
					.map(([, flag]) => flag);
				const run = await requestPeriodDigestRun({
					period,
					trigger: "scheduled",
					origin: "cli",
					...(options.account ? { account: options.account } : {}),
					...(options.birdCredentialsPath
						? { birdCredentialsPath: options.birdCredentialsPath }
						: {}),
					liveSync: Boolean(options.liveSync),
				});
				const state = await run.completion;
				print(
					{
						ok: state.phase !== "failed",
						archived: false,
						joined: run.joined,
						...(ignoredOptions.length > 0 ? { ignoredOptions } : {}),
						...state,
					},
					true,
				);
				if (state.phase === "failed") process.exitCode = 1;
				return;
			}
			if (
				options.runDate !== undefined &&
				!isCalendarDateString(options.runDate)
			) {
				throw new Error("--run-date must be a real date in YYYY-MM-DD format");
			}
			const runDate = options.runDate
				? new Date(`${options.runDate}T00:00:00`)
				: undefined;
			const result = await runDigestArchiveJob({
				period,
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
				birdCredentialsPath: options.birdCredentialsPath,
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
		.option("--env-path <path>", "Shell environment file to source")
		.option("--env-file <path>", "Deprecated alias for --env-path")
		.option(
			"--bird-credentials-path <path>",
			"Strict AUTH_TOKEN/CT0 credential file",
		)
		.option("--stdout <path>", "launchd stdout path")
		.option("--stderr <path>", "launchd stderr path")
		.option("--launch-agents-dir <path>", "LaunchAgents directory")
		.option("--no-load", "Write plist without loading it")
		.action(async (options, command) => {
			const programExplicit = command.getOptionValueSource("program") === "cli";
			const envFileExplicit =
				command.getOptionValueSource("envPath") === "cli" ||
				command.getOptionValueSource("envFile") === "cli";
			const savedExecution = resolveDigestLaunchdExecution();
			const requestedEnvFile = options.envPath ?? options.envFile;
			const execution = {
				program: programExplicit ? options.program : savedExecution.program,
				envFile: envFileExplicit ? requestedEnvFile : savedExecution.envFile,
			};
			// Fields that make sense applied identically to all 4 periods when
			// --period all is used. Labels and output paths remain per-period;
			// program/env are shared so fixed and freshness agents execute alike.
			const perPeriodOverrides = {
				program: execution.program,
				account: options.account,
				includeDms: Boolean(options.includeDms),
				contentSources: parseDigestContentSources(options.contentSources),
				archiveDir: options.archiveDir,
				retries: Number(options.retries),
				retryDelaySeconds: Number(options.retryDelaySeconds),
				logPath: options.log,
				envFile: execution.envFile,
				birdCredentialsPath: options.birdCredentialsPath,
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
				if (programExplicit || envFileExplicit) {
					setDigestLaunchdExecution({
						...(programExplicit ? { program: options.program } : {}),
						...(envFileExplicit ? { envFile: requestedEnvFile } : {}),
					});
				}
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
				stdoutPath: options.stdout,
				stderrPath: options.stderr,
				...installOptions,
				...perPeriodOverrides,
			});
			if (programExplicit || envFileExplicit) {
				setDigestLaunchdExecution({
					...(programExplicit ? { program: options.program } : {}),
					...(envFileExplicit ? { envFile: requestedEnvFile } : {}),
				});
			}
			print(result, true);
		});
}
