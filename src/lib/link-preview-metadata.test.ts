// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBirdclawPathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	__test__,
	extractLinkPreviewMetadata,
	fetchLinkPreviewMetadata,
	fetchLinkPreviewMetadataEffect,
	getOrFetchLinkPreview,
	getOrFetchLinkPreviewEffect,
} from "./link-preview-metadata";

const tempDirs: string[] = [];

afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	delete process.env.BIRDCLAW_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("link preview metadata", () => {
	it("extracts Open Graph, Twitter card, and relative images", () => {
		const metadata = extractLinkPreviewMetadata(
			`
      <html>
        <head>
          <meta property="og:title" content="Peekaboo">
          <meta name="description" content="A macOS automation tool">
          <meta property="og:site_name" content="Peekaboo">
          <meta property="og:image" content="/og.png">
        </head>
      </html>
      `,
			"https://peekaboo.sh/",
		);

		expect(metadata).toEqual({
			url: "https://peekaboo.sh/",
			title: "Peekaboo",
			description: "A macOS automation tool",
			imageUrl: "https://peekaboo.sh/og.png",
			siteName: "Peekaboo",
		});
	});

	it("falls back to YouTube thumbnails", () => {
		const metadata = extractLinkPreviewMetadata(
			"<title>Demo video</title>",
			"https://www.youtube.com/watch?v=mCO-D3pkviM",
		);

		expect(metadata.imageUrl).toBe(
			"https://i.ytimg.com/vi/mCO-D3pkviM/hqdefault.jpg",
		);
		expect(__test__.youtubeThumbnail("https://youtu.be/GMIWm5y90xA")).toBe(
			"https://i.ytimg.com/vi/GMIWm5y90xA/hqdefault.jpg",
		);
		expect(
			__test__.youtubeThumbnail("https://www.youtube.com/shorts/GMIWm5y90xA"),
		).toBe("https://i.ytimg.com/vi/GMIWm5y90xA/hqdefault.jpg");
		expect(
			__test__.youtubeThumbnail(
				"https://youtube-nocookie.com/embed/GMIWm5y90xA",
			),
		).toBe("https://i.ytimg.com/vi/GMIWm5y90xA/hqdefault.jpg");
		expect(__test__.youtubeThumbnail("not a url")).toBeNull();
		expect(__test__.youtubeThumbnail("https://youtu.be/no")).toBeNull();
	});

	it("handles metadata fallbacks, duplicates, and loose attributes", () => {
		const metadata = extractLinkPreviewMetadata(
			`
      <head>
        <meta name=description value='First &amp; best'>
        <meta property="og:description" content="">
        <meta property="og:description" content="OG description">
        <meta property="og:description" content="Duplicate">
        <meta property="application-name" content="App">
        <meta property="twitter:image" content="::bad-url">
      </head>
      `,
			"https://example.com/posts/1",
		);

		expect(metadata).toEqual({
			url: "https://example.com/posts/1",
			title: "example.com",
			description: "OG description",
			imageUrl: "https://example.com/posts/::bad-url",
			siteName: "App",
		});
	});

	it("keeps malformed numeric HTML entities as text", () => {
		const metadata = extractLinkPreviewMetadata(
			"<title>&#999999999999; Demo</title>",
			"https://example.com/",
		);

		expect(metadata.title).toBe("&#999999999999; Demo");
	});

	it("treats direct image responses as image previews", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/card.png",
			headers: new Headers({ "content-type": "image/png" }),
			text: vi.fn(),
		});

		await expect(
			fetchLinkPreviewMetadata("https://example.com/card.png", { fetchImpl }),
		).resolves.toMatchObject({
			imageUrl: "https://example.com/card.png",
			siteName: "example.com",
			title: "example.com",
		});
	});

	it("blocks local and private link preview targets before fetching", async () => {
		const fetchImpl = vi.fn();

		await expect(
			fetchLinkPreviewMetadata("http://127.0.0.1/admin", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview URL points to a private host",
		});
		await expect(
			fetchLinkPreviewMetadata("http://localhost:3000/", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview URL points to a private host",
		});
		await expect(
			fetchLinkPreviewMetadata("http://[::1]/", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview URL points to a private host",
		});
		await expect(
			fetchLinkPreviewMetadata("http://[::ffff:127.0.0.1]/", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview URL points to a private host",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(__test__.isBlockedAddress("10.0.0.5")).toBe(true);
		expect(__test__.isBlockedAddress("[::ffff:7f00:1]")).toBe(true);
		expect(__test__.isBlockedAddress("0:0:0:0:0:0:0:1")).toBe(true);
		expect(__test__.isBlockedAddress("0:0:0:0:0:ffff:7f00:1")).toBe(true);
		expect(__test__.isBlockedAddress("[::ffff:0:7f00:1]")).toBe(true);
		expect(__test__.isBlockedAddress("[::7f00:1]")).toBe(true);
		expect(__test__.isBlockedAddress("[64:ff9b::7f00:1]")).toBe(true);
		expect(__test__.isBlockedAddress("[64:ff9b:1::7f00:1]")).toBe(true);
		expect(__test__.isBlockedAddress("[2002:7f00:1::]")).toBe(true);
		expect(__test__.isBlockedAddress("[fe80::1]")).toBe(true);
		expect(__test__.isBlockedAddress("fec0::1")).toBe(true);
		expect(__test__.isBlockedAddress("ff02::1")).toBe(true);
		expect(__test__.isBlockedAddress("not-an-address")).toBe(false);
		expect(__test__.isBlockedAddress("8.8.8.8")).toBe(false);
	});

	it("covers address parser edge cases used by preview host checks", () => {
		expect(__test__.safeHttpUrl(undefined)).toBeNull();
		expect(__test__.safeHttpUrl("mailto:test@example.com")).toBeNull();
		expect(__test__.safeHttpUrl("not a url")).toBeNull();
		expect(__test__.safeHttpUrl("https://example.com/a")).toBe(
			"https://example.com/a",
		);
		expect(__test__.ipv4ToNumber("1.2.3")).toBeNull();
		expect(__test__.ipv4ToNumber("1.2.3.x")).toBeNull();
		expect(__test__.ipv4ToNumber("256.1.1.1")).toBeNull();
		expect(__test__.isIpv4InRange("8.8.8.8", "0.0.0.0", 0)).toBe(true);
		expect(__test__.isIpv4InRange("bad", "0.0.0.0", 0)).toBe(false);
		expect(__test__.isIpv4InRange("8.8.8.8", "bad", 0)).toBe(false);
		expect(__test__.parseIpv6Parts("8.8.8.8")).toBeNull();
		expect(__test__.parseIpv6Parts("not-an-ip")).toBeNull();
		expect(__test__.parseIpv6Parts("1::2::3")).toBeNull();
		expect(__test__.parseIpv6Parts("1:2:3")).toBeNull();
		expect(__test__.parseIpv6Parts("1:2:3:4:5:6:7:8:9")).toBeNull();
		expect(__test__.parseIpv6Parts("1:2:3:4:5:6:7:zzzz")).toBeNull();
		expect(__test__.parseIpv6Parts("::ffff:999.0.0.1")).toBeNull();
		expect(__test__.parseIpv6Parts("::ffff:127.0.0.1")).toEqual([
			0, 0, 0, 0, 0, 0xffff, 0x7f00, 1,
		]);
		expect(__test__.ipv4FromIpv6Suffix("::ffff:7f00:1")).toBe("127.0.0.1");
		expect(__test__.ipv4FromIpv6Suffix("::ffff:127.0.0.1")).toBe("127.0.0.1");
		expect(__test__.ipv4FromIpv6Suffix("64:ff9b::7f00:1")).toBe("127.0.0.1");
		expect(__test__.ipv4FromIpv6Suffix("64:ff9b:1::7f00:1")).toBe("127.0.0.1");
		expect(__test__.ipv4FromIpv6Suffix("::ffff:zzzz")).toBeNull();
		expect(__test__.ipv4FromIpv6Suffix("not-an-ip")).toBeNull();
		expect(__test__.isPrivateIpv6("::")).toBe(true);
		expect(__test__.isPrivateIpv6("::1")).toBe(true);
		expect(__test__.isPrivateIpv6("not-an-ip")).toBe(false);
		expect(__test__.isPrivateIpv6("fd00::1")).toBe(true);
		expect(__test__.isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
		expect(() =>
			__test__.assertSafePreviewUrl("https://example.com/"),
		).not.toThrow();
	});

	it("rejects unsupported schemes and credentialed preview URLs", async () => {
		const fetchImpl = vi.fn();

		await expect(
			fetchLinkPreviewMetadata("file:///tmp/card.html", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview URL must use http or https",
		});
		await expect(
			fetchLinkPreviewMetadata("https://user:pass@example.com/", {
				fetchImpl,
			}),
		).resolves.toMatchObject({
			error: "Link preview URL must not include credentials",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("answers Node lookup callbacks in all-address mode", () => {
		const callback = vi.fn();

		__test__.respondWithResolvedAddress(
			{ address: "93.184.216.34", family: 4 },
			{ all: true },
			callback,
		);

		expect(callback).toHaveBeenCalledWith(null, [
			{ address: "93.184.216.34", family: 4 },
		]);
	});

	it("answers Node lookup callbacks in single-address mode", () => {
		const callback = vi.fn();

		__test__.respondWithResolvedAddress(
			{ address: "93.184.216.34", family: 4 },
			undefined,
			callback,
		);

		expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
	});

	it("blocks DNS resolutions and redirects to private addresses", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("", {
					status: 302,
					headers: { location: "http://internal.example.test/admin" },
				}),
			)
			.mockResolvedValueOnce(new Response("<title>private</title>"));
		const resolveHost = vi.fn(async (hostname: string) =>
			hostname === "example.com" ? ["93.184.216.34"] : ["10.0.0.8"],
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", {
				fetchImpl,
				resolveHost,
			}),
		).resolves.toMatchObject({
			error: "Link preview URL points to a private host",
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(resolveHost).toHaveBeenCalledWith("example.com");
	});

	it("reports DNS resolution failures before fetching", async () => {
		const fetchImpl = vi.fn();

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", {
				fetchImpl,
				resolveHost: vi.fn(async () => []),
			}),
		).resolves.toMatchObject({
			error: "Link preview host did not resolve",
		});
		await expect(
			fetchLinkPreviewMetadata("https://example.com/", {
				fetchImpl,
				resolveHost: vi.fn(async () => ["not-an-address"]),
			}),
		).resolves.toMatchObject({
			error: "Link preview host resolved to an invalid address",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("stops redirect loops and cancels redirect bodies", async () => {
		const cancel = vi.fn();
		const fetchImpl = vi.fn().mockImplementation(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					status: 302,
					headers: { location: "/next" },
				}),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/start", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview redirected too many times",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(cancel).toHaveBeenCalledTimes(5);
	});

	it("treats redirect responses without locations as fetch responses", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 304 }));

		await expect(
			fetchLinkPreviewMetadata("https://example.com/cache", { fetchImpl }),
		).resolves.toMatchObject({
			error: "HTTP 304",
		});
	});

	it("times out before fetching when no time remains", async () => {
		const fetchImpl = vi.fn();

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", {
				fetchImpl,
				timeoutMs: 0,
			}),
		).resolves.toMatchObject({
			error: "Link preview request timed out",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects injected fetches outside tests", async () => {
		const previousNodeEnv = process.env.NODE_ENV;
		const previousVitest = process.env.VITEST;
		process.env.NODE_ENV = "production";
		delete process.env.VITEST;
		try {
			await expect(
				fetchLinkPreviewMetadata("https://example.com/", {
					fetchImpl: vi.fn(),
				}),
			).resolves.toMatchObject({
				error: "Custom link preview fetch is only available in tests",
			});
		} finally {
			if (previousNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = previousNodeEnv;
			}
			if (previousVitest === undefined) {
				delete process.env.VITEST;
			} else {
				process.env.VITEST = previousVitest;
			}
		}
	});

	it("caps oversized link preview bodies", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response("too much", {
				headers: {
					"content-length": "2000001",
					"content-type": "text/html",
				},
			}),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview response is too large",
		});
	});

	it("uses default body decoding for uncompressed responses", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response("<title>Plain</title>", {
				headers: { "content-type": "text/html" },
			}),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", { fetchImpl }),
		).resolves.toMatchObject({
			title: "Plain",
		});
	});

	it("caps streamed link preview bodies while reading", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(2_000_001));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/html" } },
			),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Link preview response is too large",
		});
	});

	it.each([
		["gzip", gzipSync],
		["x-gzip", gzipSync],
		["deflate", deflateSync],
		["br", brotliCompressSync],
	])("decodes %s link preview bodies", async (encoding, compress) => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(compress(`<title>${encoding}</title>`), {
				headers: {
					"content-encoding": encoding,
					"content-type": "text/html",
				},
			}),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", { fetchImpl }),
		).resolves.toMatchObject({
			title: encoding,
		});
	});

	it("cancels direct image response bodies", async () => {
		const cancel = vi.fn();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(new ReadableStream({ cancel }), {
				headers: { "content-type": "image/png" },
			}),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/card.png", { fetchImpl }),
		).resolves.toMatchObject({
			imageUrl: "https://example.com/card.png",
			siteName: "example.com",
			title: "example.com",
		});
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("returns preview errors for malformed redirects", async () => {
		const cancel = vi.fn();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(new ReadableStream({ cancel }), {
				status: 302,
				headers: { location: "http://[" },
			}),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/", { fetchImpl }),
		).resolves.toMatchObject({
			error: "Invalid URL",
		});
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("cancels non-OK link preview response bodies", async () => {
		const cancel = vi.fn();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(new ReadableStream({ cancel }), {
				status: 404,
				headers: { "content-type": "text/html" },
			}),
		);

		await expect(
			fetchLinkPreviewMetadata("https://example.com/missing", { fetchImpl }),
		).resolves.toMatchObject({
			error: "HTTP 404",
		});
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("keeps link preview fetch effects lazy", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/card.png",
			headers: new Headers({ "content-type": "image/png" }),
			text: vi.fn(),
		});

		const effect = fetchLinkPreviewMetadataEffect(
			"https://example.com/card.png",
			{ fetchImpl },
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			imageUrl: "https://example.com/card.png",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("persists fetched previews on url expansions", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-preview-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();

		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://peekaboo.sh/",
			headers: new Headers({ "content-type": "text/html" }),
			text: vi.fn().mockResolvedValue(`
        <meta property="og:title" content="Peekaboo">
        <meta property="og:image" content="https://peekaboo.sh/og.png">
      `),
		});

		await expect(
			getOrFetchLinkPreview("https://peekaboo.sh/", {
				shortUrl: "https://t.co/demo",
				fetchImpl,
			}),
		).resolves.toMatchObject({
			title: "Peekaboo",
			imageUrl: "https://peekaboo.sh/og.png",
		});

		expect(
			getNativeDb({ seedDemoData: false })
				.prepare(
					"select title, image_url from url_expansions where short_url = ?",
				)
				.get("https://t.co/demo"),
		).toEqual({
			title: "Peekaboo",
			image_url: "https://peekaboo.sh/og.png",
		});
	});

	it("returns safe cached previews without refetching", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-preview-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		getNativeDb({ seedDemoData: false })
			.prepare(
				`
				insert into url_expansions (
					short_url, expanded_url, final_url, status, title, description,
					image_url, site_name, error, source, updated_at
				) values (?, ?, ?, 'hit', ?, ?, ?, ?, null, 'metadata', ?)
				`,
			)
			.run(
				"https://t.co/cached",
				"https://example.com/cached",
				"https://example.com/final",
				"Cached title",
				"Cached description",
				"https://example.com/card.png",
				"Example",
				"2026-05-17T00:00:00.000Z",
			);
		const fetchImpl = vi.fn();

		await expect(
			getOrFetchLinkPreview("https://example.com/final", {
				shortUrl: "https://t.co/cached",
				fetchImpl,
			}),
		).resolves.toEqual({
			url: "https://example.com/final",
			title: "Cached title",
			description: "Cached description",
			imageUrl: "https://example.com/card.png",
			siteName: "Example",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refetches unsafe or non-hit cached previews", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-preview-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();
		getNativeDb({ seedDemoData: false }).exec(`
			insert into url_expansions (
				short_url, expanded_url, final_url, status, title, description,
				image_url, site_name, error, source, updated_at
			) values
				('https://t.co/unsafe-image', 'https://example.com/unsafe-image',
				 'https://example.com/unsafe-image', 'hit', 'Unsafe image', null,
				 'http://127.0.0.1/card.png', 'Example', null, 'metadata',
				 '2026-05-17T00:00:00.000Z'),
				('https://t.co/miss', 'https://example.com/miss',
				 'https://example.com/miss', 'miss', 'Miss', null,
				 null, 'Example', 'HTTP 404', 'metadata',
				 '2026-05-17T00:00:00.000Z')
		`);
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/refetched",
			headers: new Headers({ "content-type": "text/html" }),
			text: vi.fn().mockResolvedValue("<title>Refetched</title>"),
		});

		await expect(
			getOrFetchLinkPreview("https://example.com/unsafe-image", {
				shortUrl: "https://t.co/unsafe-image",
				fetchImpl,
			}),
		).resolves.toMatchObject({ title: "Refetched" });
		await expect(
			getOrFetchLinkPreview("https://example.com/miss", {
				shortUrl: "https://t.co/miss",
				fetchImpl,
			}),
		).resolves.toMatchObject({ title: "Refetched" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("keeps cached-preview effects lazy until run", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-preview-"));
		tempDirs.push(tempDir);
		process.env.BIRDCLAW_HOME = tempDir;
		resetBirdclawPathsForTests();
		resetDatabaseForTests();

		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			url: "https://example.com/",
			headers: new Headers({ "content-type": "text/html" }),
			text: vi.fn().mockResolvedValue("<title>Example</title>"),
		});

		const effect = getOrFetchLinkPreviewEffect("https://example.com/", {
			fetchImpl,
		});
		expect(fetchImpl).not.toHaveBeenCalled();

		await expect(Effect.runPromise(effect)).resolves.toMatchObject({
			title: "Example",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
