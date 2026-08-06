// @vitest-environment node
import { describe, expect, it } from "vitest";
import { periodDigestMetadataPollInterval } from "./usePeriodDigestMetadata";

describe("period digest metadata polling", () => {
	it("polls slowly while idle and quickly while a batch is active", () => {
		expect(periodDigestMetadataPollInterval(false)).toBe(30_000);
		expect(periodDigestMetadataPollInterval(true)).toBe(3_000);
	});
});
