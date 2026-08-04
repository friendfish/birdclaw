import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getBirdclawPaths } from "./config";

export interface BirdCredentials {
	authToken: string;
	ct0: string;
}

export interface BirdCredentialStatus {
	configured: boolean;
	complete: boolean;
	updatedAt?: string;
}

const CREDENTIAL_KEYS = new Set(["AUTH_TOKEN", "CT0"]);

export function getBirdCredentialsPath() {
	return path.join(getBirdclawPaths().rootDir, "credentials", "bird.env");
}

function validateCredentialValue(value: string) {
	if (!value.trim()) {
		throw new Error("Both AUTH_TOKEN and CT0 are required");
	}
	if (/[\r\n]/u.test(value)) {
		throw new Error("Credential values cannot contain a line break");
	}
}

function parseCredentials(content: string): BirdCredentials | null {
	const withoutFinalNewline = content.endsWith("\n")
		? content.slice(0, -1)
		: content;
	const lines = withoutFinalNewline.split("\n");
	if (lines.length !== 2) return null;

	const values = new Map<string, string>();
	for (const line of lines) {
		const separator = line.indexOf("=");
		if (separator <= 0) return null;
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (!CREDENTIAL_KEYS.has(key) || values.has(key)) return null;
		try {
			validateCredentialValue(value);
		} catch {
			return null;
		}
		values.set(key, value);
	}

	const authToken = values.get("AUTH_TOKEN");
	const ct0 = values.get("CT0");
	return authToken && ct0 ? { authToken, ct0 } : null;
}

export function readBirdCredentials(): BirdCredentials | null {
	return readBirdCredentialsFile(getBirdCredentialsPath());
}

export function readBirdCredentialsFile(
	credentialsPath: string,
): BirdCredentials | null {
	try {
		return parseCredentials(readFileSync(credentialsPath, "utf8"));
	} catch {
		return null;
	}
}

export function getBirdCredentialStatus(): BirdCredentialStatus {
	try {
		const credentialsPath = getBirdCredentialsPath();
		const stats = statSync(credentialsPath);
		return {
			configured: true,
			complete: readBirdCredentials() !== null,
			updatedAt: stats.mtime.toISOString(),
		};
	} catch {
		return { configured: false, complete: false };
	}
}

export function writeBirdCredentials(
	credentials: BirdCredentials,
): BirdCredentialStatus {
	validateCredentialValue(credentials.authToken);
	validateCredentialValue(credentials.ct0);

	const credentialsPath = getBirdCredentialsPath();
	const credentialsDir = path.dirname(credentialsPath);
	mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
	chmodSync(credentialsDir, 0o700);

	const temporaryPath = path.join(
		credentialsDir,
		`.bird.env.${process.pid}.${randomUUID()}.tmp`,
	);
	const content = `AUTH_TOKEN=${credentials.authToken}\nCT0=${credentials.ct0}\n`;
	try {
		writeFileSync(temporaryPath, content, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, credentialsPath);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}

	return getBirdCredentialStatus();
}

export function clearBirdCredentials() {
	try {
		unlinkSync(getBirdCredentialsPath());
	} catch (error) {
		if (
			!error ||
			typeof error !== "object" ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}
	}
}

export function mergeBirdCredentialEnvironment(
	explicit?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const credentials = readBirdCredentials();
	return {
		...(credentials
			? { AUTH_TOKEN: credentials.authToken, CT0: credentials.ct0 }
			: {}),
		...process.env,
		...explicit,
	};
}
