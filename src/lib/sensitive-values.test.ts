// @vitest-environment node
import { describe, expect, it } from "vitest";
import { redactSensitiveText, sensitiveErrorMessage } from "./sensitive-values";

describe("sensitive value redaction", () => {
	it("redacts X credentials, bearer tokens, and sensitive URL parameters", () => {
		const secretAuth = "auth-secret-123";
		const secretCt0 = "ct0-secret-456";
		const value = [
			`AUTH_TOKEN=${secretAuth}`,
			`ct0: ${secretCt0}`,
			"Authorization: Bearer bearer-secret-789",
			"https://example.com/callback?auth_token=query-secret&safe=value",
		].join("\n");

		const redacted = redactSensitiveText(value);

		expect(redacted).not.toContain(secretAuth);
		expect(redacted).not.toContain(secretCt0);
		expect(redacted).not.toContain("bearer-secret-789");
		expect(redacted).not.toContain("query-secret");
		expect(redacted).toContain("safe=value");
		expect(redacted).toContain("[REDACTED]");
	});

	it("normalizes non-Error values before redacting them", () => {
		expect(sensitiveErrorMessage("CT0=raw-secret")).toBe("CT0=[REDACTED]");
	});
});
