// @vitest-environment node
import { describe, expect, it } from "vitest";

describe("test environment security", () => {
	it("does not inherit live Bird credentials", () => {
		expect(Boolean(process.env.AUTH_TOKEN)).toBe(false);
		expect(Boolean(process.env.CT0)).toBe(false);
	});

	it("does not inherit any secret-shaped environment variables", () => {
		const inheritedNames = Object.keys(process.env).filter((name) =>
			/(?:AUTH_TOKEN|CT0|API_KEY|TOKEN|SECRET|PASSWORD|COOKIE)/iu.test(name),
		);
		expect(inheritedNames).toEqual([]);
	});
});
