import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { runSubprocessEffect } from "./subprocess";

const DEFAULT_LAUNCHD_PATH =
	"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type LaunchAgentSchedule =
	| { kind: "interval"; intervalSeconds: number }
	| {
			kind: "calendar";
			hour: number;
			minute: number;
			weekday?: number;
			year?: number;
			month?: number;
			day?: number;
	  };

export interface LaunchAgent {
	label: string;
	schedule: LaunchAgentSchedule;
	logPath: string;
	stdoutPath: string;
	stderrPath: string;
	programArguments: string[];
	plist: string;
	runAtLoad: boolean;
	envFile?: string;
}

export interface LaunchAgentInstallResult {
	ok: true;
	label: string;
	plistPath: string;
	loaded: boolean;
	programArguments: string[];
	logPath: string;
	stdoutPath: string;
	stderrPath: string;
	schedule: LaunchAgentSchedule;
	envFile?: string;
}

const installQueues = new Map<string, Promise<void>>();

function serializeInstall<T>(plistPath: string, install: () => Promise<T>) {
	const previous = installQueues.get(plistPath) ?? Promise.resolve();
	const operation = previous.then(install);
	const tail = operation.then(
		() => undefined,
		() => undefined,
	);
	installQueues.set(plistPath, tail);
	return operation.finally(() => {
		if (installQueues.get(plistPath) === tail) installQueues.delete(plistPath);
	});
}

export interface LaunchAgentInstallOptions {
	launchAgentsDir?: string;
	load?: boolean;
}

export function launchAgentPlistPath(
	label: string,
	options: LaunchAgentInstallOptions = {},
) {
	const launchAgentsDir = resolveUserPath(
		options.launchAgentsDir ?? "~/Library/LaunchAgents",
	);
	return path.join(launchAgentsDir, `${label}.plist`);
}

export function expandHomePath(input: string) {
	return input === "~" || input.startsWith("~/")
		? path.join(os.homedir(), input.slice(2))
		: input;
}

export function resolveUserPath(input: string) {
	return path.resolve(expandHomePath(input));
}

export function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildLaunchProgramArguments({
	program = "birdclaw",
	args,
	envFile,
}: {
	program?: string;
	args: string[];
	envFile?: string;
}) {
	const programArguments =
		path.isAbsolute(program) || program.includes("/")
			? [program]
			: ["/usr/bin/env", program];
	programArguments.push(...args);
	if (!envFile) return programArguments;

	const resolvedEnvFile = resolveUserPath(envFile);
	return [
		"/bin/bash",
		"-lc",
		[
			"set -a",
			`[ ! -f ${shellQuote(resolvedEnvFile)} ] || . ${shellQuote(resolvedEnvFile)}`,
			"set +a",
			`exec ${programArguments.map(shellQuote).join(" ")}`,
		].join("; "),
	];
}

function xmlEscape(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function stringEntry(value: string) {
	return `<string>${xmlEscape(value)}</string>`;
}

function scheduleXml(schedule: LaunchAgentSchedule) {
	if (schedule.kind === "interval") {
		return `<key>StartInterval</key>
  <integer>${String(schedule.intervalSeconds)}</integer>`;
	}
	const calendarEntries = [
		["Year", schedule.year],
		["Month", schedule.month],
		["Day", schedule.day],
		["Weekday", schedule.weekday],
		["Hour", schedule.hour],
		["Minute", schedule.minute],
	]
		.filter((entry): entry is [string, number] => entry[1] !== undefined)
		.map(
			([key, value]) =>
				`    <key>${key}</key>\n    <integer>${String(value)}</integer>`,
		)
		.join("\n");
	return `<key>StartCalendarInterval</key>
  <dict>
${calendarEntries}
  </dict>`;
}

export function buildLaunchAgent({
	label,
	schedule,
	logPath,
	stdoutPath,
	stderrPath,
	programArguments,
	envFile,
	runAtLoad = true,
}: Omit<LaunchAgent, "plist" | "envFile" | "runAtLoad"> & {
	envFile?: string;
	runAtLoad?: boolean;
}): LaunchAgent {
	const resolvedLogPath = resolveUserPath(logPath);
	const resolvedStdoutPath = resolveUserPath(stdoutPath);
	const resolvedStderrPath = resolveUserPath(stderrPath);
	const resolvedEnvFile = envFile ? resolveUserPath(envFile) : undefined;
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringEntry(label)}
  <key>ProgramArguments</key>
  <array>
    ${programArguments.map(stringEntry).join("\n    ")}
  </array>
  ${scheduleXml(schedule)}
  <key>RunAtLoad</key>
  <${runAtLoad ? "true" : "false"}/>
  <key>StandardOutPath</key>
  ${stringEntry(resolvedStdoutPath)}
  <key>StandardErrorPath</key>
  ${stringEntry(resolvedStderrPath)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${stringEntry(DEFAULT_LAUNCHD_PATH)}
  </dict>
</dict>
</plist>
`;
	return {
		label,
		schedule,
		logPath: resolvedLogPath,
		stdoutPath: resolvedStdoutPath,
		stderrPath: resolvedStderrPath,
		programArguments,
		plist,
		runAtLoad,
		...(resolvedEnvFile ? { envFile: resolvedEnvFile } : {}),
	};
}

export function installLaunchAgentEffect(
	agent: LaunchAgent,
	options: LaunchAgentInstallOptions = {},
): Effect.Effect<LaunchAgentInstallResult, unknown> {
	return Effect.gen(function* () {
		const plistPath = launchAgentPlistPath(agent.label, options);
		const launchAgentsDir = path.dirname(plistPath);
		for (const directory of [
			launchAgentsDir,
			path.dirname(agent.logPath),
			path.dirname(agent.stdoutPath),
			path.dirname(agent.stderrPath),
		]) {
			yield* tryPromise(() => fs.mkdir(directory, { recursive: true }));
		}
		const loaded = yield* tryPromise(() =>
			serializeInstall(plistPath, async () => {
				const temporaryPath = `${plistPath}.${process.pid}.${randomUUID()}.tmp`;
				try {
					await fs.writeFile(temporaryPath, agent.plist, "utf8");
					await fs.rename(temporaryPath, plistPath);
				} finally {
					await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
				}
				if (options.load === false) return false;
				await Effect.runPromise(
					runSubprocessEffect({
						command: "launchctl",
						args: ["unload", plistPath],
					}).pipe(Effect.catchAll(() => Effect.void)),
				);
				await Effect.runPromise(
					runSubprocessEffect({
						command: "launchctl",
						args: ["load", "-w", plistPath],
					}),
				);
				return true;
			}),
		);

		return {
			ok: true,
			label: agent.label,
			plistPath,
			loaded,
			programArguments: agent.programArguments,
			logPath: agent.logPath,
			stdoutPath: agent.stdoutPath,
			stderrPath: agent.stderrPath,
			schedule: agent.schedule,
			...(agent.envFile ? { envFile: agent.envFile } : {}),
		};
	});
}

export function installLaunchAgent(
	agent: LaunchAgent,
	options: LaunchAgentInstallOptions = {},
) {
	return runEffectPromise(installLaunchAgentEffect(agent, options));
}
