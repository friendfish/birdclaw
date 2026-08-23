import { exportBookmarks } from "#/lib/bookmark-export";
import type { CliCommandContext } from "./command-context";

export function registerBookmarkCommands({
	program,
	print,
	asJson,
}: CliCommandContext) {
	const bookmarksCommand = program
		.command("bookmarks")
		.description("Archive local bookmarks as Markdown");

	bookmarksCommand
		.command("export")
		.description("Export local bookmarks to the Markdown archive")
		.option("--account <username>", "Account username or id")
		.option("--archive-dir <path>", "Override the configured archive directory")
		.option("--full", "Re-render all current bookmark files")
		.action(async (options) => {
			const result = await exportBookmarks({
				account: options.account,
				archiveDir: options.archiveDir,
				full: Boolean(options.full),
			});
			print(
				asJson()
					? result
					: `Bookmark archive: ${String(result.created)} created, ${String(result.updated)} updated, ${String(result.unchanged)} unchanged, ${String(result.conflicted)} conflicted`,
				asJson(),
			);
			if (!result.ok) process.exitCode = 1;
		});
}
