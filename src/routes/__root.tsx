import {
	createRootRoute,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { z } from "zod";
import { AppNav } from "#/components/AppNav";
import { GlobalBackgroundSync } from "#/components/GlobalBackgroundSync";
import { fetchJson } from "#/lib/api-client";
import { BirdclawQueryProvider } from "#/lib/query-client";
import { ThemeProvider, themeScript } from "#/lib/theme";
import {
	DEFAULT_TODAY_MAX_WIDTH_PX,
	EXPANDED_SIDEBAR_WIDTH_PX,
	todayUiConfigSchema,
} from "#/lib/ui-layout";
import {
	bodyClass,
	mainColumnClass,
	mainColumnDmClass,
	siteShellClass,
} from "#/lib/ui";

import appCss from "../styles.css?url";

const uiConfigResponseSchema = z.object({
	ok: z.boolean(),
	ui: todayUiConfigSchema,
});

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "birdclaw",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	notFoundComponent: NotFoundView,
	shellComponent: RootDocument,
});

function NotFoundView() {
	return (
		<main className={mainColumnClass}>
			<div className="px-4 py-10 text-[var(--ink-soft)]">Not Found</div>
		</main>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
				<script suppressHydrationWarning>{themeScript}</script>
			</head>
			<body className={bodyClass}>
				<BirdclawQueryProvider>
					<ThemeProvider>
						<GlobalBackgroundSync />
						<AppShell pathname={pathname}>{children}</AppShell>
					</ThemeProvider>
				</BirdclawQueryProvider>
				<Scripts />
			</body>
		</html>
	);
}

export function AppShell({
	children,
	pathname,
}: {
	children: ReactNode;
	pathname: string;
}) {
	const wideMode =
		pathname.startsWith("/dms") || pathname.startsWith("/network-map");
	const todayMode = pathname === "/today" || pathname.startsWith("/today/");
	const [todayMaxWidthPx, setTodayMaxWidthPx] = useState(
		DEFAULT_TODAY_MAX_WIDTH_PX,
	);
	useEffect(() => {
		if (!todayMode) return;
		const controller = new AbortController();
		void fetchJson(
			"/api/ui-config",
			{ signal: controller.signal },
			uiConfigResponseSchema,
			"Failed to load UI config",
		)
			.then((response) => {
				if (response.ok) setTodayMaxWidthPx(response.ui.todayMaxWidthPx);
			})
			.catch(() => undefined);
		return () => controller.abort();
	}, [todayMode]);
	const todayShellMaxWidthPx = todayMaxWidthPx + EXPANDED_SIDEBAR_WIDTH_PX;

	return (
		<div
			className={siteShellClass}
			style={todayMode ? { maxWidth: todayShellMaxWidthPx } : undefined}
		>
			<AppNav compact={wideMode} />
			<main
				className={wideMode || todayMode ? mainColumnDmClass : mainColumnClass}
				style={todayMode ? { maxWidth: todayMaxWidthPx } : undefined}
			>
				{children}
			</main>
		</div>
	);
}
