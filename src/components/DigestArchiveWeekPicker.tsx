import { cx, selectFieldClass } from "#/lib/ui";
import type { DigestArchiveDateOption } from "./useReadOnlyDigest";

function weekLabel(date: string) {
	const parsed = new Date(`${date}T00:00:00`);
	if (Number.isNaN(parsed.getTime())) return date;
	return `Week of ${parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

export function DigestArchiveWeekPicker({
	dates,
	value,
	onChange,
}: {
	dates: DigestArchiveDateOption[];
	value: string;
	onChange: (date: string) => void;
}) {
	return (
		<select
			aria-label="Select archived week"
			className={cx(selectFieldClass, "h-9 w-[170px]!")}
			value={value}
			onChange={(event) => onChange(event.target.value)}
		>
			<option value="">Latest</option>
			{dates.map((item) => (
				<option key={item.date} value={item.date}>
					{weekLabel(item.date)}
				</option>
			))}
		</select>
	);
}
