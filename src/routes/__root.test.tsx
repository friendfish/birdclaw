import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerState = vi.hoisted(() => ({ path: "/inbox" }));
const appNavProps: Array<{ compact?: boolean }> = vi.hoisted(() => []);

vi.mock("@tanstack/react-router", () => ({
	createRootRoute: (options: Record<string, unknown>) => ({ options }),
	HeadContent: () => null,
	Scripts: () => <div data-testid="scripts" />,
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => string;
	}) => select({ location: { pathname: routerState.path } }),
}));

vi.mock("#/components/AppNav", () => ({
	AppNav: (props: { compact?: boolean }) => {
		appNavProps.push(props);
		return <nav>birdclaw nav {props.compact ? "compact" : "full"}</nav>;
	},
}));

import { AppShell, Route } from "./__root";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("root route", () => {
	it("exposes document metadata and renders shell chrome", () => {
		routerState.path = "/inbox";
		appNavProps.length = 0;
		const routeOptions = Route.options as unknown as {
			head?: () => unknown;
			shellComponent: ({ children }: { children: ReactNode }) => ReactNode;
		};
		const head = routeOptions.head?.();
		const Shell = routeOptions.shellComponent as ({
			children,
		}: {
			children: ReactNode;
		}) => ReactNode;

		const markup = renderToStaticMarkup(
			<Shell>
				<main>child content</main>
			</Shell>,
		);

		expect(head).toMatchObject({
			meta: expect.arrayContaining([
				expect.objectContaining({ charSet: "utf-8" }),
				expect.objectContaining({ name: "viewport" }),
				expect.objectContaining({ title: "birdclaw" }),
			]),
			links: expect.arrayContaining([
				expect.objectContaining({ rel: "stylesheet" }),
			]),
		});
		expect(markup).toContain("birdclaw nav");
		expect(markup).toContain("max-w-[1280px]");
		expect(markup).toContain("child content");
		expect(markup).toContain('data-testid="scripts"');
		expect(markup).not.toContain("Tanstack Router");
		expect(appNavProps).toEqual([{ compact: false }]);
	});

	it("uses the configurable default width for Today without compacting navigation", () => {
		routerState.path = "/today";
		appNavProps.length = 0;
		const routeOptions = Route.options as unknown as {
			shellComponent: ({ children }: { children: ReactNode }) => ReactNode;
		};
		const Shell = routeOptions.shellComponent as ({
			children,
		}: {
			children: ReactNode;
		}) => ReactNode;

		const markup = renderToStaticMarkup(
			<Shell>
				<div>today content</div>
			</Shell>,
		);

		expect(markup).toContain('style="max-width:1220px"');
		expect(markup).toContain('style="max-width:960px"');
		expect(markup).not.toContain("max-w-[680px]");
		expect(markup).toContain("birdclaw nav full");
		expect(appNavProps).toEqual([{ compact: false }]);
	});

	it("applies the configured Today width to the main column and outer shell", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://localhost");
				if (url.pathname !== "/api/ui-config") {
					throw new Error(`Unexpected request: ${url.pathname}`);
				}
				return new Response(
					JSON.stringify({ ok: true, ui: { todayMaxWidthPx: 1120 } }),
					{ headers: { "content-type": "application/json" } },
				);
			}),
		);

		render(
			<AppShell pathname="/today">
				<div>configured today</div>
			</AppShell>,
		);
		const main = screen.getByRole("main");
		expect(main.style.maxWidth).toBe("960px");
		expect(main.parentElement?.style.maxWidth).toBe("1220px");

		await waitFor(() => expect(main.style.maxWidth).toBe("1120px"));
		expect(main.parentElement?.style.maxWidth).toBe("1380px");
	});

	it("keeps the shell position stable for messages mode", () => {
		routerState.path = "/dms";
		appNavProps.length = 0;
		const routeOptions = Route.options as unknown as {
			shellComponent: ({ children }: { children: ReactNode }) => ReactNode;
		};
		const Shell = routeOptions.shellComponent as ({
			children,
		}: {
			children: ReactNode;
		}) => ReactNode;

		const markup = renderToStaticMarkup(
			<Shell>
				<main>messages</main>
			</Shell>,
		);

		expect(markup).toContain("max-w-[1280px]");
		expect(markup).not.toContain("max-w-[680px]");
		expect(markup).toContain("birdclaw nav compact");
		expect(appNavProps).toEqual([{ compact: true }]);
	});

	it("uses the wide shell for the network map workspace", () => {
		routerState.path = "/network-map";
		appNavProps.length = 0;
		const routeOptions = Route.options as unknown as {
			shellComponent: ({ children }: { children: ReactNode }) => ReactNode;
		};
		const Shell = routeOptions.shellComponent as ({
			children,
		}: {
			children: ReactNode;
		}) => ReactNode;

		const markup = renderToStaticMarkup(
			<Shell>
				<main>map</main>
			</Shell>,
		);

		expect(markup).toContain("max-w-[1280px]");
		expect(markup).not.toContain("max-w-[680px]");
		expect(markup).toContain("birdclaw nav compact");
		expect(appNavProps).toEqual([{ compact: true }]);
	});
});
