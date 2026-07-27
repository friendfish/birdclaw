import {
	Calendar as CalendarIcon,
	ChevronLeft,
	ChevronRight,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx, secondaryButtonClass } from "#/lib/ui";
import type { DigestArchiveDateOption } from "./useReadOnlyDigest";

function pad2(value: number) {
	return String(value).padStart(2, "0");
}

function toDateKey(year: number, month: number, day: number) {
	return `${String(year)}-${pad2(month + 1)}-${pad2(day)}`;
}

function daysInMonth(year: number, month: number) {
	return new Date(year, month + 1, 0).getDate();
}

export function DigestArchiveCalendarPicker({
	dates,
	value,
	onChange,
}: {
	dates: DigestArchiveDateOption[];
	value: string;
	onChange: (date: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const available = useMemo(
		() => new Set(dates.map((item) => item.date)),
		[dates],
	);
	const initial = value || dates[0]?.date;
	const initialParsed = initial ? new Date(`${initial}T00:00:00`) : new Date();
	const [viewYear, setViewYear] = useState(initialParsed.getFullYear());
	const [viewMonth, setViewMonth] = useState(initialParsed.getMonth());

	useEffect(() => {
		if (!open) return;
		function onOutsideClick(event: MouseEvent) {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", onOutsideClick);
		return () => document.removeEventListener("mousedown", onOutsideClick);
	}, [open]);

	const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
	const totalDays = daysInMonth(viewYear, viewMonth);
	const cells: Array<number | null> = [
		...Array.from({ length: firstWeekday }, () => null),
		...Array.from({ length: totalDays }, (_, index) => index + 1),
	];

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				aria-label="Browse archived Yesterday dates"
				className={cx(secondaryButtonClass, "h-9 w-9 justify-center px-0")}
				onClick={() => setOpen((current) => !current)}
			>
				<CalendarIcon className="size-4" aria-hidden="true" />
			</button>
			{open ? (
				<div className="absolute right-0 z-30 mt-2 w-64 rounded-xl border border-[var(--line)] bg-[var(--bg)] p-3 shadow-lg">
					<div className="mb-2 flex items-center justify-between">
						<button
							type="button"
							aria-label="Previous month"
							className="rounded-full p-1 hover:bg-[var(--bg-hover)]"
							onClick={() =>
								setViewMonth((current) => {
									if (current === 0) {
										setViewYear((year) => year - 1);
										return 11;
									}
									return current - 1;
								})
							}
						>
							<ChevronLeft className="size-4" aria-hidden="true" />
						</button>
						<span className="text-[13px] font-semibold text-[var(--ink)]">
							{new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
								month: "long",
								year: "numeric",
							})}
						</span>
						<button
							type="button"
							aria-label="Next month"
							className="rounded-full p-1 hover:bg-[var(--bg-hover)]"
							onClick={() =>
								setViewMonth((current) => {
									if (current === 11) {
										setViewYear((year) => year + 1);
										return 0;
									}
									return current + 1;
								})
							}
						>
							<ChevronRight className="size-4" aria-hidden="true" />
						</button>
					</div>
					<button
						type="button"
						className="mb-2 w-full rounded-md py-1 text-center text-[12px] font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
						onClick={() => {
							onChange("");
							setOpen(false);
						}}
					>
						Latest
					</button>
					<div className="grid grid-cols-7 gap-1 text-center text-[11px] text-[var(--ink-soft)]">
						{["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
							<span key={`weekday-${String(index)}`}>{label}</span>
						))}
						{cells.map((day, index) => {
							if (day === null) {
								return <span key={`empty-${String(index)}`} />;
							}
							const dateKey = toDateKey(viewYear, viewMonth, day);
							const enabled = available.has(dateKey);
							const active = value === dateKey;
							return (
								<button
									key={dateKey}
									type="button"
									disabled={!enabled}
									aria-pressed={active}
									className={cx(
										"rounded-md py-1 text-[12px]",
										!enabled &&
											"cursor-not-allowed text-[var(--ink-soft)] opacity-40",
										enabled && !active && "hover:bg-[var(--bg-hover)]",
										active && "bg-[var(--accent)] font-semibold text-white",
									)}
									onClick={() => {
										onChange(dateKey);
										setOpen(false);
									}}
								>
									{day}
								</button>
							);
						})}
					</div>
				</div>
			) : null}
		</div>
	);
}
