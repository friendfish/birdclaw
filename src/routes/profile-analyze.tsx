import { createFileRoute } from "@tanstack/react-router";
import { Loader2, RefreshCw, Search, UserSearch } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
	cleanProfileHandle,
	formatProfileAnalysisCounts,
	ProfileAnalysisOutput,
	ProfileAnalysisStatusLine,
	useProfileAnalysisStream,
} from "#/components/ProfileAnalysisStream";
import {
	cx,
	pageHeaderActionsClass,
	pageHeaderClass,
	pageHeaderRowClass,
	pageSubtitleClass,
	pageTitleClass,
	primaryButtonClass,
	searchFieldIconClass,
	searchFieldInputClass,
	searchFieldShellClass,
	secondaryButtonClass,
} from "#/lib/ui";

export const Route = createFileRoute("/profile-analyze")({
	component: ProfileAnalyzeRoute,
	validateSearch: (search: Record<string, unknown>) => ({
		handle: typeof search.handle === "string" ? search.handle : "",
	}),
});

function ProfileAnalyzeRoute() {
	const search = Route.useSearch();
	const [handle, setHandle] = useState(cleanProfileHandle(search.handle));
	const submittedHandle = useMemo(() => cleanProfileHandle(handle), [handle]);
	const analysis = useProfileAnalysisStream(submittedHandle);
	const autoRunHandleRef = useRef("");
	const runAnalysisRef = useRef(analysis.run);

	useEffect(() => {
		runAnalysisRef.current = analysis.run;
	}, [analysis.run]);

	useEffect(() => {
		const urlHandle = cleanProfileHandle(search.handle);
		setHandle(urlHandle);
		if (urlHandle && autoRunHandleRef.current !== urlHandle) {
			autoRunHandleRef.current = urlHandle;
			runAnalysisRef.current(false, urlHandle);
		}
	}, [search.handle]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		analysis.run(false);
	};

	return (
		<section className="flex min-h-screen flex-col gap-6 px-4 py-8">
			<header className={cx(pageHeaderClass, "border-b-0")}>
				<div className={pageHeaderRowClass}>
					<div>
						<h1 className={pageTitleClass}>Profile Analyse</h1>
						<p className={pageSubtitleClass}>
							{formatProfileAnalysisCounts(analysis.context)}
						</p>
					</div>
					<div className={pageHeaderActionsClass}>
						<button
							className={secondaryButtonClass}
							disabled={!submittedHandle || analysis.loading}
							onClick={() => analysis.run(true)}
							type="button"
						>
							<RefreshCw className="size-4" strokeWidth={1.8} />
							Refresh
						</button>
					</div>
				</div>
				<form
					className="mt-5 flex flex-col gap-3 sm:flex-row"
					onSubmit={submit}
				>
					<label className={cx(searchFieldShellClass, "min-w-0 flex-1")}>
						<Search className={searchFieldIconClass} strokeWidth={1.8} />
						<input
							className={searchFieldInputClass}
							onChange={(event) => setHandle(event.target.value)}
							placeholder="handle"
							value={handle}
						/>
					</label>
					<button
						className={primaryButtonClass}
						disabled={!submittedHandle || analysis.loading}
						type="submit"
					>
						{analysis.loading ? (
							<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
						) : (
							<UserSearch className="size-4" strokeWidth={1.8} />
						)}
						Analyse
					</button>
				</form>
			</header>

			<ProfileAnalysisStatusLine analysis={analysis} />
			<ProfileAnalysisOutput analysis={analysis} />
		</section>
	);
}
