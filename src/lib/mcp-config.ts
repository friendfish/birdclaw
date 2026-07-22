import { isIP } from "node:net";

export interface McpConfig {
	token: string;
	publicUrl: URL;
	accountSelector?: string;
	reserveHost: boolean;
}

export type McpConfigState =
	| { kind: "disabled" }
	| { kind: "enabled"; config: McpConfig }
	| { kind: "invalid"; message: string };

type McpEnvironment = Record<string, string | undefined>;

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/u;

export function isLoopbackHostname(hostname: string) {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		(isIP(normalized) === 4 && normalized.split(".")[0] === "127")
	);
}

export function readMcpConfig(
	environment: McpEnvironment = process.env,
): McpConfigState {
	const configuredMcpBearer = environment.BIRDCLAW_MCP_TOKEN;
	const publicUrlValue = environment.BIRDCLAW_MCP_PUBLIC_URL;
	const accountSelectorValue = environment.BIRDCLAW_MCP_ACCOUNT;

	if (!configuredMcpBearer && !publicUrlValue) {
		if (accountSelectorValue) {
			return {
				kind: "invalid",
				message:
					"BIRDCLAW_MCP_ACCOUNT requires BIRDCLAW_MCP_TOKEN and BIRDCLAW_MCP_PUBLIC_URL",
			};
		}
		return { kind: "disabled" };
	}
	if (!configuredMcpBearer) {
		return {
			kind: "invalid",
			message: "BIRDCLAW_MCP_TOKEN is required when MCP is configured",
		};
	}
	if (!publicUrlValue) {
		return {
			kind: "invalid",
			message: "BIRDCLAW_MCP_PUBLIC_URL is required when MCP is configured",
		};
	}
	if (
		configuredMcpBearer !== configuredMcpBearer.trim() ||
		!BEARER_TOKEN_PATTERN.test(configuredMcpBearer) ||
		Buffer.byteLength(configuredMcpBearer) < 32
	) {
		return {
			kind: "invalid",
			message:
				"BIRDCLAW_MCP_TOKEN must be at least 32 bytes and use RFC 6750 bearer-token characters",
		};
	}
	const webToken = environment.BIRDCLAW_WEB_TOKEN?.trim();
	if (webToken && webToken === configuredMcpBearer) {
		return {
			kind: "invalid",
			message: "BIRDCLAW_MCP_TOKEN must differ from BIRDCLAW_WEB_TOKEN",
		};
	}

	let publicUrl: URL;
	try {
		publicUrl = new URL(publicUrlValue);
	} catch {
		return {
			kind: "invalid",
			message: "BIRDCLAW_MCP_PUBLIC_URL must be an absolute URL",
		};
	}
	if (
		publicUrl.pathname !== "/mcp" ||
		publicUrlValue.includes("?") ||
		publicUrlValue.includes("#") ||
		publicUrl.search ||
		publicUrl.hash ||
		publicUrl.username ||
		publicUrl.password
	) {
		return {
			kind: "invalid",
			message:
				"BIRDCLAW_MCP_PUBLIC_URL must use the exact /mcp path without credentials, query, or fragment",
		};
	}
	const loopback = isLoopbackHostname(publicUrl.hostname);
	if (
		publicUrl.protocol !== "https:" &&
		!(publicUrl.protocol === "http:" && loopback)
	) {
		return {
			kind: "invalid",
			message:
				"BIRDCLAW_MCP_PUBLIC_URL must use HTTPS, except for loopback HTTP",
		};
	}

	const accountSelector = accountSelectorValue?.trim();
	if (
		accountSelectorValue !== undefined &&
		(!accountSelector ||
			accountSelector !== accountSelectorValue ||
			accountSelector.length > 256 ||
			/[\u0000-\u001f\u007f]/u.test(accountSelector))
	) {
		return {
			kind: "invalid",
			message:
				"BIRDCLAW_MCP_ACCOUNT must be one account ID or handle without surrounding whitespace",
		};
	}
	if (accountSelector?.toLowerCase() === "all") {
		return {
			kind: "invalid",
			message:
				"BIRDCLAW_MCP_ACCOUNT must select one account; all-account MCP access is disabled",
		};
	}

	return {
		kind: "enabled",
		config: {
			token: configuredMcpBearer,
			publicUrl,
			...(accountSelector ? { accountSelector } : {}),
			reserveHost: !loopback,
		},
	};
}
