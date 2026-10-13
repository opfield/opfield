import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./index.js";

const env = {
	GITHUB_OWNER: "opfield",
	GITHUB_OPFIELD_REPO: "opfield",
	GITHUB_INFERENCE_CORE_REPO: "inference-core",
	GITHUB_INFERENCE_CORE_TOKEN: "private-core-token",
} as Env;

function release(tag_name: string, prerelease = tag_name.includes("-rc.")) {
	return {
		tag_name,
		name: tag_name,
		body: "",
		html_url: `https://github.com/opfield/opfield/releases/tag/${tag_name}`,
		published_at: "2026-08-27T00:00:00Z",
		draft: false,
		prerelease,
		assets: [],
	};
}

// One GitHub page of release candidates newer than any stable release.
const releaseCandidatePage = Array.from({ length: 100 }, (_, index) =>
	release(`v2.11.0-rc.${100 - index}`),
);

function releasePage(releases: ReturnType<typeof release>[], next: boolean) {
	return Response.json(releases, {
		headers: next
			? {
					Link: '<https://api.github.com/repositories/1/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/releases?per_page=100&page=9>; rel="last"',
				}
			: {},
	});
}

describe("gateway update facade", () => {
	it("serves health without contacting GitHub", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(
			new Request("https://updates.thesqlabs.com/health"),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			service: "opfield-updates",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("normalizes public GitHub releases for Opfield clients", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json([
					{
						tag_name: "v2.9.11",
						name: "Opfield v2.9.11",
						body: "Release notes",
						html_url: "https://github.com/opfield/opfield/releases/tag/v2.9.11",
						published_at: "2026-08-27T00:00:00Z",
						draft: false,
						prerelease: false,
						assets: [],
					},
				]),
			)
			.mockResolvedValueOnce(
				Response.json([
					{
						tag_name: "v2.25.0-wiolett.21",
						name: "Inference Core v2.25.0-wiolett.21",
						body: "Core release notes",
						html_url:
							"https://github.com/opfield/inference-core/releases/tag/v2.25.0-wiolett.21",
						published_at: "2026-08-27T00:00:00Z",
						draft: false,
						prerelease: false,
						assets: [],
					},
				]),
			);
		const response = await handleRequest(
			new Request("https://updates.thesqlabs.com/gateway/releases"),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual([
			expect.objectContaining({
				tag_name: "v2.9.11",
				description: "Release notes",
			}),
			expect.objectContaining({
				tag_name: "v2.25.0-wiolett.21",
				description: "Core release notes",
			}),
		]);
		const opfieldHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
		const coreHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
		expect(opfieldHeaders.get("Authorization")).toBe(
			"Bearer private-core-token",
		);
		expect(coreHeaders.get("Authorization")).toBe("Bearer private-core-token");
	});

	it.each([
		["v1.1.9", "v1.1.12", "patch"],
		["v1.1.12", "v1.2.0", "minor-baseline"],
		["v1.2.0", "v1.2.1", "patch"],
	])("stages Opfield updates from %s to %s", async (current, target, reason) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					release("v1.1.12"),
					release("v1.2.0"),
					release("v1.2.1"),
					release("v2.0.0"),
				]),
			);
		const response = await handleRequest(
			new Request(
				`https://updates.thesqlabs.com/gateway/releases?component=gateway&current=${current}`,
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			component: "gateway",
			current,
			reason,
			target: { tag_name: target },
		});
	});

	it("keeps release candidates out of the stable channel", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([release("v1.1.10-rc.2"), release("v1.1.9")]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v1.1.9",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(204);
	});

	it("offers the newest release candidate in the preview channel", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					release("v1.1.10-rc.1"),
					release("v1.1.10-rc.3"),
					release("v1.1.10-rc.2"),
				]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v1.1.9&channel=preview",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			target: { tag_name: "v1.1.10-rc.3" },
		});
	});

	it("prefers the final stable release over its release candidates", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([release("v1.1.10-rc.3"), release("v1.1.10")]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v1.1.10-rc.2&channel=preview",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			target: { tag_name: "v1.1.10" },
		});
	});

	it("offers the final stable release when an RC installation returns to stable", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json([release("v1.1.10")]));
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v1.1.10-rc.2&channel=stable",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			target: { tag_name: "v1.1.10" },
		});
	});

	it("supports preview component tags with the RC segment before the suffix", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json([release("v1.2.0-rc.4-nginx")]));
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=nginx-daemon&current=v1.1.9-nginx&channel=preview",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			target: { tag_name: "v1.2.0-rc.4-nginx" },
		});
	});

	it("serves the lease watchdog on its own release line", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					release("v1.1.12-docker"),
					release("v1.1.11-watchdog"),
					release("v1.1.10-watchdog"),
				]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=lease-watchdog&current=v1.1.10",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "patch",
			target: { tag_name: "v1.1.11-watchdog" },
		});
	});

	it("pages past release candidates to the stable releases on the next page", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(releasePage(releaseCandidatePage, true))
			.mockResolvedValueOnce(
				releasePage([release("v2.10.1-relay"), release("v2.10.1")], false),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&channel=stable",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "latest",
			target: { tag_name: "v2.10.1" },
		});
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			"https://api.github.com/repos/opfield/opfield/releases?per_page=100&page=1",
			"https://api.github.com/repos/opfield/opfield/releases?per_page=100&page=2",
		]);
	});

	it("reads until the installed version so a patch on an older page wins over the next minor", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				releasePage(
					[release("v2.11.0"), ...releaseCandidatePage.slice(1)],
					true,
				),
			)
			.mockResolvedValueOnce(
				releasePage([release("v2.10.1"), release("v2.10.0")], true),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v2.10.0&channel=stable",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "patch",
			target: { tag_name: "v2.10.1" },
		});
		// The second page reached v2.10.0, so the third page is never requested.
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("stops at the page limit when no release settles the search", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => releasePage(releaseCandidatePage, true));
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v2.10.1&channel=stable",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(204);
		expect(fetcher).toHaveBeenCalledTimes(10);
	});

	it("fails instead of answering from a partial list when a later page fails", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(releasePage(releaseCandidatePage, true))
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&channel=stable",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(502);
	});

	it("lists stable Opfield releases from a later page", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(releasePage(releaseCandidatePage, true))
			.mockResolvedValueOnce(
				releasePage([release("v2.25.0-wiolett.21")], false),
			)
			.mockResolvedValueOnce(releasePage([release("v2.10.1")], false));
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?channel=stable",
			),
			env,
			fetcher,
		);
		const listed = (await response.json()) as { tag_name: string }[];
		expect(listed.map((entry) => entry.tag_name)).toEqual([
			"v2.10.1",
			"v2.25.0-wiolett.21",
		]);
	});

	it("rejects unknown update channels without contacting GitHub", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v1.1.9&channel=nightly",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "invalid_channel",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("does not automatically cross a major version", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json([release("v2.0.0")]));
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v1.9.9",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("returns the latest inference core build directly", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					release("v2.25.0-wiolett.21"),
					release("v2.26.0-wiolett.1"),
				]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=inference-core&current=v2.24.0-wiolett.9",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "latest",
			target: { tag_name: "v2.26.0-wiolett.1" },
		});
	});

	it("orders thesqlabs core builds after the legacy wiolett line", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([
					release("v2.60.0-wiolett.9"),
					release("v2.60.0-thesqlabs.1"),
					release("v2.25.0-wiolett.27"),
				]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=inference-core&current=v2.25.0-wiolett.27",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "latest",
			target: { tag_name: "v2.60.0-thesqlabs.1" },
		});
	});

	it("orders opfield core builds after the thesqlabs line", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json([
					release("v2.60.6-thesqlabs.6"),
					release("v2.61.0-opfield.1"),
					release("v2.61.0-thesqlabs.9"),
					release("v2.60.0-wiolett.40"),
				]),
			);
		const response = await handleRequest(
			new Request(
				"https://get.opfield.dev/gateway/releases?component=inference-core&current=v2.60.6-thesqlabs.6",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "latest",
			target: { tag_name: "v2.61.0-opfield.1" },
		});
		const current = await handleRequest(
			new Request(
				"https://get.opfield.dev/gateway/releases?component=inference-core&current=v2.61.0-opfield.1",
			),
			env,
			fetcher,
		);
		expect(current.status).toBe(204);
	});

	it("returns the latest component release when current is omitted", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json([release("v1.2.0-relay"), release("v1.2.1-relay")]),
			);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/releases?component=relay",
			),
			env,
			fetcher,
		);
		await expect(response.json()).resolves.toMatchObject({
			reason: "latest",
			target: { tag_name: "v1.2.1-relay" },
		});
	});

	it("does not keep the legacy root release path", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(
			new Request("https://updates.thesqlabs.com/releases"),
			env,
			fetcher,
		);
		expect(response.status).toBe(404);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects paths outside the release contract without upstream access", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/gateway/v2.9.11/../../secrets",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(404);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("streams a release asset and does not forward GitHub authorization to the signed redirect", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					tag_name: "v2.9.11",
					name: null,
					body: null,
					html_url: "https://github.com/opfield/opfield/releases/tag/v2.9.11",
					published_at: "2026-08-27T00:00:00Z",
					draft: false,
					prerelease: false,
					assets: [
						{
							id: 123,
							name: "gateway-image.update.json",
							size: 7,
							content_type: "application/json",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: {
						Location:
							"https://release-assets.githubusercontent.com/signed-download",
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response("payload", {
					headers: { "Content-Type": "application/json" },
				}),
			);

		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/gateway/v2.9.11/gateway-image.update.json",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("payload");
		const redirectHeaders = new Headers(fetcher.mock.calls[2]?.[1]?.headers);
		expect(redirectHeaders.has("Authorization")).toBe(false);
	});

	it("serves the latest stable server installer at the root with a short cache", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					...release("v2.12.0"),
					assets: [
						{ id: 7, name: "install.sh", size: 9, content_type: "text/x-sh" },
					],
				}),
			)
			.mockResolvedValueOnce(new Response("#!/bin/sh"));

		const response = await handleRequest(
			new Request("https://get.opfield.dev/"),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("#!/bin/sh");
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"https://api.github.com/repos/opfield/opfield/releases/latest",
		);
		expect(String(fetcher.mock.calls[1]?.[0])).toContain("/releases/assets/7");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
	});

	it("serves the license endpoints document of the latest stable release under every host name", async () => {
		const fetcher = vi.fn<typeof fetch>(async (input) =>
			String(input).endsWith("/releases/latest")
				? Response.json({
						...release("v2.12.0"),
						assets: [
							{
								id: 9,
								name: "license-endpoints.json",
								size: 2,
								content_type: "application/json",
							},
						],
					})
				: new Response("{}"),
		);
		for (const host of ["get.opfield.dev", "updates.thesqlabs.com"]) {
			fetcher.mockClear();
			const response = await handleRequest(
				new Request(`https://${host}/gateway/license-endpoints.json`),
				env,
				fetcher,
			);
			expect(response.status).toBe(200);
			await expect(response.text()).resolves.toBe("{}");
			expect(String(fetcher.mock.calls[0]?.[0])).toBe(
				"https://api.github.com/repos/opfield/opfield/releases/latest",
			);
			expect(String(fetcher.mock.calls[1]?.[0])).toContain(
				"/releases/assets/9",
			);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		}
	});

	it("answers 404 while the latest release carries no license endpoints document", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json(release("v2.12.0")));
		const response = await handleRequest(
			new Request("https://get.opfield.dev/gateway/license-endpoints.json"),
			env,
			fetcher,
		);
		expect(response.status).toBe(404);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("serves a release's node installers in the GitHub download layout", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					...release("v2.12.0"),
					assets: [
						{
							id: 8,
							name: "setup-node.sh",
							size: 9,
							content_type: "text/x-sh",
						},
					],
				}),
			)
			.mockResolvedValueOnce(new Response("#!/bin/sh"));

		const response = await handleRequest(
			new Request(
				"https://get.opfield.dev/gateway/releases/download/v2.12.0/setup-node.sh",
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"https://api.github.com/repos/opfield/opfield/releases/tags/v2.12.0",
		);
		expect(response.headers.get("Cache-Control")).toContain("immutable");
	});

	it.each([
		"opfield-node-installers.sha256",
		// legacy-name: the checksum list of releases before 2.12.1.
		"gateway-daemon-installers.sha256",
	])("serves the installer checksum list %s", async (name) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					...release("v2.12.1"),
					assets: [{ id: 9, name, size: 9, content_type: "text/plain" }],
				}),
			)
			.mockResolvedValueOnce(new Response("abc  setup-node.sh"));

		const response = await handleRequest(
			new Request(
				`https://get.opfield.dev/gateway/releases/download/v2.12.1/${name}`,
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
	});

	it.each([
		"https://get.opfield.dev/gateway/releases/download/v2.12.0-docker/setup-node.sh",
		"https://get.opfield.dev/gateway/releases/download/v2.12.0/docker-compose.yml",
		"https://get.opfield.dev/gateway/releases/latest/download/../secrets",
	])("refuses installer paths outside the allowlist: %s", async (url) => {
		const fetcher = vi.fn<typeof fetch>();
		const response = await handleRequest(new Request(url), env, fetcher);
		expect(response.status).toBe(404);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("answers HEAD from release metadata without downloading the asset", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				tag_name: "v2.9.11-docker",
				name: null,
				body: null,
				html_url:
					"https://github.com/opfield/opfield/releases/tag/v2.9.11-docker",
				published_at: "2026-08-27T00:00:00Z",
				draft: false,
				prerelease: false,
				assets: [
					{
						id: 456,
						name: "docker-daemon-linux-amd64",
						size: 1024,
						content_type: "application/octet-stream",
					},
				],
			}),
		);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/docker-daemon/v2.9.11-docker/docker-daemon-linux-amd64",
				{
					method: "HEAD",
				},
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Length")).toBe("1024");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("reads inference core assets from the private core repository", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				tag_name: "v2.25.0-wiolett.21",
				name: null,
				body: null,
				html_url:
					"https://github.com/opfield/inference-core/releases/tag/v2.25.0-wiolett.21",
				published_at: "2026-08-27T00:00:00Z",
				draft: false,
				prerelease: false,
				assets: [
					{
						id: 789,
						name: "opencodex-image.update.json",
						size: 2048,
						content_type: "application/json",
					},
				],
			}),
		);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/inference-core/v2.25.0-wiolett.21/opencodex-image.update.json",
				{ method: "HEAD" },
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/repos/opfield/inference-core/releases/tags/v2.25.0-wiolett.21",
		);
		const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
		expect(headers.get("Authorization")).toBe("Bearer private-core-token");
	});

	it("serves witness artifacts from the Opfield release", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				...release("v2.12.0"),
				assets: [
					{
						id: 901,
						name: "witness-clickhouse-keeper-25.8.28.1-linux-arm64.update.json",
						size: 512,
						content_type: "application/json",
					},
				],
			}),
		);
		const response = await handleRequest(
			new Request(
				"https://updates.thesqlabs.com/gateway/witness-clickhouse-keeper/v2.12.0/witness-clickhouse-keeper-25.8.28.1-linux-arm64.update.json",
				{ method: "HEAD" },
			),
			env,
			fetcher,
		);
		expect(response.status).toBe(200);
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/repos/opfield/opfield/releases/tags/v2.12.0",
		);
		for (const path of [
			"witness-clickhouse-keeper/v2.12.0-relay/witness-clickhouse-keeper-25.8.28.1-linux-arm64",
			"witness-clickhouse-keeper/v2.12.0/witness-clickhouse-keeper-25.8.28.1-linux-riscv64",
			"witness-clickhouse-keeper/v2.12.0/gateway-image.update.json",
		]) {
			const refused = await handleRequest(
				new Request(`https://updates.thesqlabs.com/gateway/${path}`),
				env,
				fetcher,
			);
			expect(refused.status).toBe(404);
		}
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
