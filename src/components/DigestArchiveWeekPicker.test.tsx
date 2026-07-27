import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestArchiveWeekPicker } from "./DigestArchiveWeekPicker";
import type { DigestArchiveDateOption } from "./useReadOnlyDigest";

afterEach(() => {
	cleanup();
});

describe("DigestArchiveWeekPicker", () => {
	it("renders a Latest option plus one per archived week, most recent first", () => {
		render(
			<DigestArchiveWeekPicker
				dates={
					[
						{ date: "2026-07-20", contentSources: ["all"] },
						{ date: "2026-07-13", contentSources: ["all"] },
					] satisfies DigestArchiveDateOption[]
				}
				onChange={vi.fn()}
				value=""
			/>,
		);

		const select = screen.getByRole("combobox", {
			name: "Select archived week",
		});
		const options = Array.from(select.querySelectorAll("option")).map(
			(option) => option.textContent,
		);
		expect(options[0]).toBe("Latest");
		expect(options).toHaveLength(3);
	});

	it("reflects the selected value and fires onChange", () => {
		const onChange = vi.fn();
		render(
			<DigestArchiveWeekPicker
				dates={
					[
						{ date: "2026-07-20", contentSources: ["all"] },
					] satisfies DigestArchiveDateOption[]
				}
				onChange={onChange}
				value="2026-07-20"
			/>,
		);

		const select = screen.getByRole("combobox", {
			name: "Select archived week",
		});
		expect(select).toHaveValue("2026-07-20");

		fireEvent.change(select, { target: { value: "" } });
		expect(onChange).toHaveBeenCalledWith("");
	});
});
