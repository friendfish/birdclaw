// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isLoopbackHostname, readMcpConfig } from "./mcp-config";

const token = ["birdclaw-mcp", "test-token", "0123456789", "abcdef"].join("-");

describe("Birdclaw MCP configuration", () => {
	it("is disabled only when all MCP settings are absent", () => {
		expect(readMcpConfig({})).toEqual({ kind: "disabled" });
		expect(readMcpConfig({ BIRDCLAW_MCP_TOKEN: token })).toMatchObject({
			kind: "invalid",
			message: expect.stringContaining("BIRDCLAW_MCP_PUBLIC_URL"),
		});
		expect(
			readMcpConfig({
				BIRDCLAW_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
			}),
		).toMatchObject({
			kind: "invalid",
			message: expect.stringContaining("BIRDCLAW_MCP_TOKEN"),
		});
		expect(
			readMcpConfig({ BIRDCLAW_MCP_ACCOUNT: "acct_primary" }),
		).toMatchObject({ kind: "invalid" });
	});

	it("accepts exact HTTPS and loopback HTTP endpoints", () => {
		const external = readMcpConfig({
			BIRDCLAW_MCP_TOKEN: token,
			BIRDCLAW_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
			BIRDCLAW_MCP_ACCOUNT: "@owner",
		});
		expect(external).toMatchObject({
			kind: "enabled",
			config: { accountSelector: "@owner", reserveHost: true },
		});

		const local = readMcpConfig({
			BIRDCLAW_MCP_TOKEN: token,
			BIRDCLAW_MCP_PUBLIC_URL: "http://127.0.0.1:31415/mcp",
		});
		expect(local).toMatchObject({
			kind: "enabled",
			config: { reserveHost: false },
		});
	});

	it.each([
		["short token", "short", "https://mcp.example.com/mcp"],
		["whitespace token", `${token} `, "https://mcp.example.com/mcp"],
		["comma token", `${token},suffix`, "https://mcp.example.com/mcp"],
		["NUL token", `${token}\0`, "https://mcp.example.com/mcp"],
		["non-ASCII token", `${token}🔐`, "https://mcp.example.com/mcp"],
		["malformed URL", token, "not-a-url"],
		["wrong path", token, "https://mcp.example.com/other"],
		["path suffix", token, "https://mcp.example.com/mcp/"],
		["query", token, "https://mcp.example.com/mcp?debug=1"],
		["empty query", token, "https://mcp.example.com/mcp?"],
		["fragment", token, "https://mcp.example.com/mcp#debug"],
		["empty fragment", token, "https://mcp.example.com/mcp#"],
		["credentials", token, "https://user@mcp.example.com/mcp"],
		["remote HTTP", token, "http://mcp.example.com/mcp"],
	])("rejects %s", (_label, candidateToken, url) => {
		expect(
			readMcpConfig({
				BIRDCLAW_MCP_TOKEN: candidateToken,
				BIRDCLAW_MCP_PUBLIC_URL: url,
			}),
		).toMatchObject({ kind: "invalid" });
	});

	it("fails closed for token reuse and all-account scope", () => {
		expect(
			readMcpConfig({
				BIRDCLAW_MCP_TOKEN: token,
				BIRDCLAW_WEB_TOKEN: token,
				BIRDCLAW_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
			}),
		).toMatchObject({
			kind: "invalid",
			message: expect.stringContaining("must differ"),
		});
		expect(
			readMcpConfig({
				BIRDCLAW_MCP_TOKEN: token,
				BIRDCLAW_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
				BIRDCLAW_MCP_ACCOUNT: "all",
			}),
		).toMatchObject({ kind: "invalid" });
	});

	it("recognizes only actual loopback hostnames", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("127.0.0.42")).toBe(true);
		expect(isLoopbackHostname("::1")).toBe(true);
		expect(isLoopbackHostname("127.attacker.example")).toBe(false);
		expect(isLoopbackHostname("0.0.0.0")).toBe(false);
	});
});
