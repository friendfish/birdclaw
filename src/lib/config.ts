import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BirdclawPaths {
	rootDir: string;
	dbPath: string;
	mediaOriginalsDir: string;
	mediaThumbsDir: string;
	configPath: string;
}

export type LiveDataSource = "auto" | "bird" | "xurl";
export type MentionsDataSource = "birdclaw" | LiveDataSource;
export type ActionsTransport = "auto" | "bird" | "xurl";
// Deliberately not imported from period-digest.ts's PeriodDigestPreset to
// avoid a circular import (period-digest.ts already imports getBirdclawConfig
// from here) — structurally identical, no runtime dependency needed.
export type DigestSchedulePeriod = "today" | "yesterday" | "24h" | "week";

export interface DigestScheduleTime {
	hour?: number;
	minute?: number;
	weekday?: number;
}

export interface BirdclawConfig {
	accounts?: {
		default?: string;
	};
	mentions?: {
		dataSource?: MentionsDataSource;
		birdCommand?: string;
	};
	live?: {
		dataSource?: LiveDataSource;
	};
	actions?: {
		transport?: ActionsTransport;
	};
	digest?: {
		freshnessSeconds?: number;
		archiveDir?: string;
		schedule?: Partial<Record<DigestSchedulePeriod, DigestScheduleTime>>;
	};
	backup?: {
		repoPath?: string;
		remote?: string;
		autoSync?: boolean;
		staleAfterSeconds?: number;
	};
	ai?: {
		provider?: string;
		baseUrl?: string;
		apiKey?: string;
		model?: string;
	};
	language?: {
		aiLanguage?: string;
		uiLanguage?: string;
	};
}

export function getDefaultAccountSelector() {
	const selector = getBirdclawConfig().accounts?.default?.trim();
	return selector || undefined;
}

let cachedPaths: BirdclawPaths | undefined;
let cachedConfig: BirdclawConfig | undefined;

export function getBirdclawPaths(): BirdclawPaths {
	if (cachedPaths) {
		return cachedPaths;
	}

	const rootDir =
		process.env.BIRDCLAW_HOME?.trim() || path.join(os.homedir(), ".birdclaw");

	cachedPaths = {
		rootDir,
		dbPath: path.join(rootDir, "birdclaw.sqlite"),
		mediaOriginalsDir: path.join(rootDir, "media", "originals"),
		mediaThumbsDir: path.join(rootDir, "media", "thumbs"),
		configPath: path.join(rootDir, "config.json"),
	};

	return cachedPaths;
}

function parseConfigFile(configPath: string): BirdclawConfig {
	if (!existsSync(configPath)) {
		return {};
	}

	const raw = readFileSync(configPath, "utf8").trim();
	if (!raw) {
		return {};
	}

	const parsed = JSON.parse(raw) as BirdclawConfig;
	return parsed && typeof parsed === "object" ? parsed : {};
}

export function getBirdclawConfig(): BirdclawConfig {
	if (cachedConfig) {
		return cachedConfig;
	}

	const configPath =
		process.env.BIRDCLAW_CONFIG?.trim() || getBirdclawPaths().configPath;
	cachedConfig = parseConfigFile(configPath);
	return cachedConfig;
}

function getConfigPath() {
	return process.env.BIRDCLAW_CONFIG?.trim() || getBirdclawPaths().configPath;
}

export function writeBirdclawConfig(config: BirdclawConfig) {
	const configPath = getConfigPath();
	mkdirSync(path.dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	cachedConfig = config;
	return configPath;
}

export function setActionsTransport(transport: ActionsTransport) {
	const config = getBirdclawConfig();
	const nextConfig: BirdclawConfig = {
		...config,
		actions: {
			...config.actions,
			transport,
		},
	};
	const configPath = writeBirdclawConfig(nextConfig);
	return { configPath, transport };
}

export function resolveMentionsDataSource(
	requestedMode?: string,
): MentionsDataSource {
	if (isMentionsDataSource(requestedMode)) {
		return requestedMode;
	}

	const liveEnvMode = process.env.BIRDCLAW_LIVE_DATA_SOURCE?.trim();
	if (isLiveDataSource(liveEnvMode)) {
		return liveEnvMode;
	}

	const liveConfigMode = getBirdclawConfig().live?.dataSource;
	if (isLiveDataSource(liveConfigMode)) {
		return liveConfigMode;
	}

	const legacyEnvMode = process.env.BIRDCLAW_MENTIONS_DATA_SOURCE?.trim();
	if (isMentionsDataSource(legacyEnvMode)) {
		return legacyEnvMode;
	}

	const legacyConfigMode = getBirdclawConfig().mentions?.dataSource;
	if (isMentionsDataSource(legacyConfigMode)) {
		return legacyConfigMode;
	}

	return "birdclaw";
}

function isLiveDataSource(value: unknown): value is LiveDataSource {
	return value === "auto" || value === "bird" || value === "xurl";
}

function isMentionsDataSource(value: unknown): value is MentionsDataSource {
	return value === "birdclaw" || isLiveDataSource(value);
}

export function resolveDigestArchiveDir(requested?: string): string {
	const explicit = requested?.trim();
	if (explicit) return path.resolve(explicit);

	const envDir = process.env.BIRDCLAW_DIGEST_ARCHIVE_DIR?.trim();
	if (envDir) return path.resolve(envDir);

	const configuredDir = getBirdclawConfig().digest?.archiveDir?.trim();
	if (configuredDir) return path.resolve(configuredDir);

	return path.join(getBirdclawPaths().rootDir, "digest-archive");
}

export function resolveActionsTransport(
	requestedMode?: string,
): ActionsTransport {
	const explicitMode = requestedMode?.trim();
	if (requestedMode !== undefined) {
		if (
			explicitMode === "auto" ||
			explicitMode === "bird" ||
			explicitMode === "xurl"
		) {
			return explicitMode;
		}
		throw new Error("Invalid action transport; expected auto, bird, or xurl");
	}

	const envMode = process.env.BIRDCLAW_ACTIONS_TRANSPORT?.trim();
	if (envMode === "auto" || envMode === "bird" || envMode === "xurl") {
		return envMode;
	}

	const configMode = getBirdclawConfig().actions?.transport;
	if (configMode === "auto" || configMode === "bird" || configMode === "xurl") {
		return configMode;
	}

	return "auto";
}

function findCommandOnPath(command: string) {
	const pathValue = process.env.PATH;
	if (!pathValue) {
		return undefined;
	}

	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) {
			continue;
		}
		const candidate = path.join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}

	return undefined;
}

export function getBirdCommand() {
	const envCommand = process.env.BIRDCLAW_BIRD_COMMAND?.trim();
	if (envCommand) {
		return envCommand;
	}

	const configuredCommand = getBirdclawConfig().mentions?.birdCommand?.trim();
	if (configuredCommand) {
		return configuredCommand;
	}

	const pathCommand = findCommandOnPath("bird");
	if (pathCommand) {
		return pathCommand;
	}

	return "bird";
}

export function ensureBirdclawDirs(): BirdclawPaths {
	const paths = getBirdclawPaths();

	mkdirSync(paths.rootDir, { recursive: true });
	mkdirSync(paths.mediaOriginalsDir, { recursive: true });
	mkdirSync(paths.mediaThumbsDir, { recursive: true });

	return paths;
}

export function resetBirdclawPathsForTests() {
	cachedPaths = undefined;
	cachedConfig = undefined;
}
