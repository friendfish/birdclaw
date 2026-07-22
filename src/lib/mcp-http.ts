import { createHash, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getStrictReadDb } from "./db";
import { type McpConfig, readMcpConfig } from "./mcp-config";
import {
	assertValidMcpAccountScope,
	createBirdclawMcpServer,
	type McpAccountScope,
} from "./mcp-tools";
import type { Database } from "./sqlite";

export const MCP_MAX_BODY_BYTES = 64 * 1024;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_RATE_CAPACITY = 20;
const MCP_RATE_REFILL_PER_MS = 1 / 1_000;
const MCP_MAX_CONCURRENT = 4;

export interface BirdclawMcpRuntime {
	config: McpConfig;
	account: McpAccountScope;
	serverVersion: string;
}

export interface McpRequestContext {
	isLoopbackPeer: boolean;
	timeoutMs?: number;
}

export interface BirdclawMcpExchange {
	response: Response;
	finalize(): void;
}

type RateBucket = {
	tokens: number;
	updatedAt: number;
	active: number;
};

const rateBuckets = new Map<string, RateBucket>();

class McpHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly headers?: HeadersInit,
		readonly jsonRpcCode = -32000,
	) {
		super(message);
	}
}

class McpTimeoutError extends Error {}

function responseHeaders(init?: HeadersInit) {
	const headers = new Headers(init);
	headers.set("cache-control", "no-store");
	headers.set("content-type", "application/json");
	headers.set("x-content-type-options", "nosniff");
	return headers;
}

function jsonRpcErrorResponse(
	status: number,
	message: string,
	code = -32000,
	headers?: HeadersInit,
) {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code, message },
			id: null,
		}),
		{ status, headers: responseHeaders(headers) },
	);
}

function resolveMcpAccount(
	db: Database,
	selector: string | undefined,
): McpAccountScope {
	const normalizedHandle = selector?.replace(/^@/u, "").toLowerCase();
	const row = selector
		? (db
				.prepare(
					`select id, handle
					 from accounts
					 where id = ?
					    or lower(ltrim(handle, '@')) = ?
					 order by case when id = ? then 0 else 1 end,
					          is_default desc,
					          created_at asc
					 limit 1`,
				)
				.get(selector, normalizedHandle, selector) as
				| { id: string; handle: string }
				| undefined)
		: (db
				.prepare(
					`select id, handle
					 from accounts
					 order by is_default desc, created_at asc
					 limit 1`,
				)
				.get() as { id: string; handle: string } | undefined);
	if (!row) {
		throw new Error(
			selector
				? "BIRDCLAW_MCP_ACCOUNT does not match a local Birdclaw account"
				: "Birdclaw MCP requires an initialized database with a local account; run birdclaw init/import first",
		);
	}
	assertValidMcpAccountScope(row);
	return row;
}

export function prepareBirdclawMcpRuntime(
	serverVersion: string,
): BirdclawMcpRuntime | null {
	const state = readMcpConfig();
	if (state.kind === "disabled") return null;
	if (state.kind === "invalid") {
		throw new Error(`Invalid Birdclaw MCP configuration: ${state.message}`);
	}
	const db = getStrictReadDb();
	return {
		config: state.config,
		account: resolveMcpAccount(db, state.config.accountSelector),
		serverVersion,
	};
}

function tokenDigest(value: string) {
	return createHash("sha256").update(value).digest();
}

function authorizeRequest(request: Request, config: McpConfig) {
	const authorization = request.headers.get("authorization") ?? "";
	const match = authorization.match(/^Bearer ([^\s,]+)$/iu);
	const candidate = match?.[1] ?? "";
	const expectedDigest = tokenDigest(config.token);
	const candidateDigest = tokenDigest(candidate);
	if (!match || !timingSafeEqual(expectedDigest, candidateDigest)) {
		throw new McpHttpError(401, "Unauthorized", {
			"www-authenticate": 'Bearer realm="birdclaw-mcp"',
		});
	}
	return expectedDigest.toString("hex");
}

function validateHostAndOrigin(
	request: Request,
	config: McpConfig,
	context: McpRequestContext,
) {
	if (!context.isLoopbackPeer) {
		throw new McpHttpError(403, "MCP requires a loopback origin connection");
	}
	const actualHost = request.headers.get("host");
	const requestUrl = new URL(request.url);
	if (
		!actualHost ||
		actualHost.toLowerCase() !== config.publicUrl.host.toLowerCase() ||
		requestUrl.host.toLowerCase() !== config.publicUrl.host.toLowerCase() ||
		requestUrl.pathname !== "/mcp" ||
		request.url.includes("?") ||
		request.url.includes("#") ||
		requestUrl.search ||
		requestUrl.hash
	) {
		throw new McpHttpError(403, "Forbidden host or path");
	}

	const origin = request.headers.get("origin");
	if (origin) {
		let parsedOrigin: URL;
		try {
			parsedOrigin = new URL(origin);
		} catch {
			throw new McpHttpError(403, "Forbidden origin");
		}
		if (
			origin !== parsedOrigin.origin ||
			parsedOrigin.origin !== config.publicUrl.origin
		) {
			throw new McpHttpError(403, "Forbidden origin");
		}
	}
	if (request.headers.get("sec-fetch-site") === "cross-site") {
		throw new McpHttpError(403, "Cross-site requests are disabled");
	}
}

function acquireRateLimit(principal: string) {
	const now = performance.now();
	const bucket = rateBuckets.get(principal) ?? {
		tokens: MCP_RATE_CAPACITY,
		updatedAt: now,
		active: 0,
	};
	bucket.tokens = Math.min(
		MCP_RATE_CAPACITY,
		bucket.tokens + (now - bucket.updatedAt) * MCP_RATE_REFILL_PER_MS,
	);
	bucket.updatedAt = now;
	rateBuckets.set(principal, bucket);

	if (bucket.active >= MCP_MAX_CONCURRENT) {
		throw new McpHttpError(429, "Too many concurrent MCP requests", {
			"retry-after": "1",
		});
	}
	if (bucket.tokens < 1) {
		const retryAfter = Math.max(
			1,
			Math.ceil((1 - bucket.tokens) / MCP_RATE_REFILL_PER_MS / 1_000),
		);
		throw new McpHttpError(429, "MCP request rate limit exceeded", {
			"retry-after": String(retryAfter),
		});
	}

	bucket.tokens -= 1;
	bucket.active += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		bucket.active = Math.max(0, bucket.active - 1);
	};
}

function isJsonContentType(value: string | null) {
	return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readJsonBody(request: Request, deadlineSignal?: AbortSignal) {
	if (!isJsonContentType(request.headers.get("content-type"))) {
		throw new McpHttpError(415, "Content-Type must be application/json");
	}
	const contentLength = request.headers.get("content-length");
	if (contentLength) {
		if (!/^\d+$/u.test(contentLength.trim())) {
			throw new McpHttpError(400, "Invalid Content-Length");
		}
		if (Number(contentLength) > MCP_MAX_BODY_BYTES) {
			throw new McpHttpError(413, "MCP request body is too large");
		}
	}
	if (!request.body) {
		throw new McpHttpError(400, "Missing MCP request body");
	}

	const reader = request.body.getReader();
	let abortKind: "client" | "deadline" | undefined;
	const cancelReader = () => {
		void reader.cancel().catch(() => undefined);
	};
	const onClientAbort = () => {
		abortKind = "client";
		cancelReader();
	};
	const onDeadline = () => {
		abortKind = "deadline";
		cancelReader();
	};
	request.signal.addEventListener("abort", onClientAbort, { once: true });
	deadlineSignal?.addEventListener("abort", onDeadline, { once: true });

	const throwIfAborted = () => {
		if (abortKind === "deadline" || deadlineSignal?.aborted) {
			throw new McpTimeoutError();
		}
		if (abortKind === "client" || request.signal.aborted) {
			throw new McpHttpError(400, "MCP request was aborted");
		}
	};
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			throwIfAborted();
			if (done) break;
			total += value.byteLength;
			if (total > MCP_MAX_BODY_BYTES) {
				throw new McpHttpError(413, "MCP request body is too large");
			}
			chunks.push(value);
		}
	} finally {
		request.signal.removeEventListener("abort", onClientAbort);
		deadlineSignal?.removeEventListener("abort", onDeadline);
		try {
			reader.releaseLock();
		} catch {
			// Cancellation may already have released the reader.
		}
	}
	const body = Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
	).toString("utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(body) as unknown;
	} catch {
		throw new McpHttpError(400, "Invalid JSON request body", undefined, -32700);
	}
	if (Array.isArray(parsed)) {
		throw new McpHttpError(
			400,
			"JSON-RPC batches are disabled",
			undefined,
			-32600,
		);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new McpHttpError(
			400,
			"JSON-RPC request body must be an object",
			undefined,
			-32600,
		);
	}
	return parsed;
}

async function withRequestDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
) {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation(controller.signal),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					controller.abort();
					reject(new McpTimeoutError());
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function secureResponse(response: Response) {
	const headers = new Headers(response.headers);
	headers.set("cache-control", "no-store");
	headers.set("x-content-type-options", "nosniff");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function handleBirdclawMcpExchangeWithTimeout(
	request: Request,
	runtime: BirdclawMcpRuntime | null,
	context: McpRequestContext,
	requestTimeoutMs: number,
): Promise<BirdclawMcpExchange> {
	let release: (() => void) | undefined;
	let server: ReturnType<typeof createBirdclawMcpServer> | undefined;
	let response: Response;
	try {
		if (!runtime) {
			throw new McpHttpError(503, "Birdclaw MCP is not configured");
		}
		const principal = authorizeRequest(request, runtime.config);
		validateHostAndOrigin(request, runtime.config, context);
		release = acquireRateLimit(principal);

		if (request.method !== "POST") {
			response = jsonRpcErrorResponse(405, "Method not allowed", -32000, {
				allow: "POST",
			});
		} else {
			response = await withRequestDeadline(async (deadlineSignal) => {
				const parsedBody = await readJsonBody(request, deadlineSignal);
				server = createBirdclawMcpServer({
					version: runtime.serverVersion,
					account: runtime.account,
				});
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await server.connect(transport);
				if (deadlineSignal.aborted) throw new McpTimeoutError();
				return transport.handleRequest(request, { parsedBody });
			}, requestTimeoutMs);
			response = secureResponse(response);
		}
	} catch (error) {
		if (error instanceof McpHttpError) {
			response = jsonRpcErrorResponse(
				error.status,
				error.message,
				error.jsonRpcCode,
				error.headers,
			);
		} else if (error instanceof McpTimeoutError) {
			response = jsonRpcErrorResponse(504, "MCP request timed out", -32603);
		} else {
			response = jsonRpcErrorResponse(500, "Internal MCP server error", -32603);
		}
	} finally {
		await Promise.allSettled([server?.close()]);
	}

	let finalized = false;
	return {
		response,
		finalize() {
			if (finalized) return;
			finalized = true;
			release?.();
		},
	};
}

export function handleBirdclawMcpExchange(
	request: Request,
	runtime: BirdclawMcpRuntime | null,
	context: McpRequestContext,
) {
	return handleBirdclawMcpExchangeWithTimeout(
		request,
		runtime,
		context,
		context.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
	);
}

export async function handleBirdclawMcpRequest(
	request: Request,
	runtime: BirdclawMcpRuntime | null,
	context: McpRequestContext,
) {
	const exchange = await handleBirdclawMcpExchange(request, runtime, context);
	exchange.finalize();
	return exchange.response;
}

export const __test__ = {
	resolveMcpAccount,
	tokenDigest,
	isJsonContentType,
	readJsonBody,
	handleExchangeWithTimeout: handleBirdclawMcpExchangeWithTimeout,
	resetRateLimits() {
		rateBuckets.clear();
	},
};
