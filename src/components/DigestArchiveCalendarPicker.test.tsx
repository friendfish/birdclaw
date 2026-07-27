import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestArchiveCalendarPicker } from "./DigestArchiveCalendarPicker";
import type { DigestArchiveDateOption } from "./useReadOnlyDigest";

afterEach(() => {
	cleanup();
});

describe("DigestArchiveCalendarPicker", () => {
	const dates: DigestArchiveDateOption[] = [
		{ date: "2026-07-21", contentSources: ["all"] },
		{ date: "2026-07-14", contentSources: ["all"] },
	];

	it("opens the month view on the selected date and disables days without an archive", () => {
		render(
			<DigestArchiveCalendarPicker
				dates={dates}
				onChange={vi.fn()}
				value="2026-07-21"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Browse archived Yesterday dates" }),
		);

		const archivedDay = screen.getByRole("button", { name: "21" });
		expect(archivedDay).not.toBeDisabled();
		expect(archivedDay).toHaveAttribute("aria-pressed", "true");

		const unarchivedDay = screen.getByRole("button", { name: "15" });
		expect(unarchivedDay).toBeDisabled();
	});

	it("calls onChange with the clicked date and closes the popover", () => {
		const onChange = vi.fn();
		render(
			<DigestArchiveCalendarPicker
				dates={dates}
				onChange={onChange}
				value="2026-07-21"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Browse archived Yesterday dates" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "14" }));

		expect(onChange).toHaveBeenCalledWith("2026-07-14");
		expect(screen.queryByText("Latest")).not.toBeInTheDocument();
	});

	it("clears the selection via the Latest shortcut", () => {
		const onChange = vi.fn();
		render(
			<DigestArchiveCalendarPicker
				dates={dates}
				onChange={onChange}
				value="2026-07-21"
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Browse archived Yesterday dates" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Latest" }));

		expect(onChange).toHaveBeenCalledWith("");
	});

	it("closes the popover when clicking outside", () => {
		render(
			<DigestArchiveCalendarPicker dates={dates} onChange={vi.fn()} value="" />,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Browse archived Yesterday dates" }),
		);
		expect(screen.getByText("Latest")).toBeInTheDocument();

		fireEvent.mouseDown(document.body);
		expect(screen.queryByText("Latest")).not.toBeInTheDocument();
	});
});
