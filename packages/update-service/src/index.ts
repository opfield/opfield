import {
	LEGACY_APP_IMAGE_MANIFEST_ASSET,
	LEGACY_APP_UPDATE_COMPONENT,
	LEGACY_CORE_RELEASE_LINE,
	LEGACY_INSTALLER_CHECKSUMS_ASSET,
	LEGACY_UPDATE_NAMESPACE,
} from "../../backend/src/lib/legacy-compat.js";

const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "opfield-update-facade";
// A page of 100 releases with 20 assets each is already past 2 MiB; the cap only guards against a runaway answer.
const RELEASE_LIST_LIMIT_BYTES = 16 * 1024 * 1024;
const RELEASE_PAGE_SIZE = 100;
// GitHub lists releases newest first; a search that is still unsettled after this many pages
// answers from what it has read.
const RELEASE_PAGE_LIMIT = 10;
// Path namespaces of the feed: the Opfield one, and the earlier one installed releases up to 2.12.2 request.
const PRODUCT_NAMESPACES: ReadonlySet<string> = new Set([
	"opfield",
	LEGACY_UPDATE_NAMESPACE,
]);
// Component of the app release: the Opfield name, and the earlier one installed releases up to 2.12.2 ask for.
const APP_COMPONENTS: ReadonlySet<string> = new Set([
	"opfield",
	LEGACY_APP_UPDATE_COMPONENT,
]);

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Fetcher = typeof fetch;

interface GitHubReleaseAsset {
	id: number;
	name: string;
	size: number;
	content_type: string;
}

interface GitHubRelease {
	tag_name: string;
	name: string | null;
	body: string | null;
	html_url: string;
	published_at: string | null;
	draft: boolean;
	prerelease: boolean;
	assets: GitHubReleaseAsset[];
}

interface NormalizedRelease {
	tag_name: string;
	name: string;
	description: string;
	body: string;
	html_url: string;
	published_at: string | null;
	prerelease: boolean;
	_links: { self: string };
}

type UpdateComponent = keyof typeof TAG_PATTERNS;
type UpdateChannel = "stable" | "preview";

interface ParsedReleaseVersion {
	major: number;
	minor: number;
	patch: number;
	build: number;
	rc: number | null;
}

interface ReleaseCandidate {
	release: GitHubRelease;
	version: ParsedReleaseVersion;
}

interface NextUpdateResponse {
	component: UpdateComponent;
	current: string | null;
	target: NormalizedRelease;
	reason: "latest" | "patch" | "minor-baseline";
}

// Inference core release lines, oldest first (see parseReleaseVersion).
const CORE_RELEASE_LINES = [LEGACY_CORE_RELEASE_LINE, "thesqlabs", "opfield"];
const CORE_LINE_ALTERNATION = CORE_RELEASE_LINES.map(escapeRegExp).join("|");
const CORE_TAG_PATTERN = new RegExp(
	`^v\\d+\\.\\d+\\.\\d+-(?:${CORE_LINE_ALTERNATION})\\.\\d+$`,
);
const CORE_VERSION_PATTERN = new RegExp(
	`^(\\d+)\\.(\\d+)\\.(\\d+)-(${CORE_LINE_ALTERNATION})\\.(\\d+)$`,
);
const APP_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
const APP_ARTIFACT_PATTERN = new RegExp(
	`^${escapeRegExp(LEGACY_APP_IMAGE_MANIFEST_ASSET)}$`,
);

const TAG_PATTERNS: Readonly<Record<string, RegExp>> = {
	opfield: APP_TAG_PATTERN,
	[LEGACY_APP_UPDATE_COMPONENT]: APP_TAG_PATTERN,
	relay: /^v\d+\.\d+\.\d+(?:-rc\.\d+)?-relay$/,
	"nginx-daemon": /^v\d+\.\d+\.\d+(?:-rc\.\d+)?-nginx$/,
	"docker-daemon": /^v\d+\.\d+\.\d+(?:-rc\.\d+)?-docker$/,
	"monitoring-daemon": /^v\d+\.\d+\.\d+(?:-rc\.\d+)?-monitoring$/,
	// The lease watchdog ships on its own line, independent of docker-daemon.
	"lease-watchdog": /^v\d+\.\d+\.\d+(?:-rc\.\d+)?-watchdog$/,
	"relay-supervisor": /^v\d+\.\d+\.\d+(?:-rc\.\d+)?-relay$/,
	// The inference core under its current name (Opfield 2.12.1 and later) and its earlier one, which Opfield 2.11.5 to
	// 2.12.0 ask for and which keeps answering.
	"opfield-inference": CORE_TAG_PATTERN,
	"inference-core": CORE_TAG_PATTERN,
	// Witness binaries (availability set Keeper voters relays run) ship as assets of the Opfield release.
	"witness-clickhouse-keeper": /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/,
};

const ARTIFACT_PATTERNS: Readonly<Record<string, RegExp>> = {
	opfield: APP_ARTIFACT_PATTERN,
	[LEGACY_APP_UPDATE_COMPONENT]: APP_ARTIFACT_PATTERN,
	relay: /^relay-image\.update\.json$/,
	"nginx-daemon":
		/^(nginx-daemon-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"docker-daemon":
		/^(docker-daemon-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"monitoring-daemon":
		/^(monitoring-daemon-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"lease-watchdog":
		/^(lease-watchdog-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	"relay-supervisor":
		/^(relay-(supervisor|worker)-linux-(amd64|arm64)(\.update\.json)?|checksums\.txt)$/,
	// Core releases from the rename on carry both manifests; earlier ones only opencodex-image.update.json.
	"opfield-inference":
		/^(opfield-inference-image|opencodex-image)\.update\.json$/,
	"inference-core": /^opencodex-image\.update\.json$/,
	"witness-clickhouse-keeper":
		/^witness-clickhouse-keeper-\d+(?:\.\d+){2,3}-linux-(amd64|arm64)(\.update\.json)?$/,
};

// Installers an Opfield release carries (scripts/stage-installers.sh), served in GitHub's release download layout:
// /<namespace>/releases/download/<tag>/<file> and /<namespace>/releases/latest/download/<file>. "/" and "/install.sh" are the
// server installer of the latest stable release.
// legacy-name: the legacy checksum list setup commands and wrappers of releases before
// 2.12.1 read — remove once no served release is older than 2.12.1.
const INSTALLER_ASSET_PATTERN = new RegExp(
	`^(install\\.sh|setup-(daemon|node|docker-node|database-node|storage-node|monitoring-node|relay-node)\\.sh|opfield-node-installers\\.sha256|${escapeRegExp(LEGACY_INSTALLER_CHECKSUMS_ASSET)})$`,
);
const LATEST_INSTALLER_CACHE_CONTROL = "public, max-age=300";
// The signed list of license service addresses Opfield installations fetch daily
// (scripts/release/license-endpoints.mjs): an asset of the latest stable release, re-signed on a schedule.
const LICENSE_ENDPOINTS_FILE = "license-endpoints.json";
const LICENSE_ENDPOINTS_ASSET = "license-endpoints.json";

interface GitHubRepository {
	name: string;
	token?: string;
}

function jsonResponse(
	body: unknown,
	status = 200,
	cacheControl = "no-store",
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": cacheControl,
			"Access-Control-Allow-Origin": "*",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function githubHeaders(
	repository: GitHubRepository,
	accept = "application/vnd.github+json",
): Headers {
	const headers = new Headers({
		Accept: accept,
		"User-Agent": USER_AGENT,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	});
	if (repository.token)
		headers.set("Authorization", `Bearer ${repository.token}`);
	return headers;
}

function githubApiUrl(
	env: Env,
	repository: GitHubRepository,
	path: string,
): string {
	return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(repository.name)}${path}`;
}

function opfieldRepository(env: Env): GitHubRepository {
	return {
		name: env.GITHUB_OPFIELD_REPO,
		token: env.GITHUB_INFERENCE_CORE_TOKEN,
	};
}

function inferenceCoreRepository(env: Env): GitHubRepository {
	return {
		name: env.GITHUB_INFERENCE_CORE_REPO,
		token: env.GITHUB_INFERENCE_CORE_TOKEN,
	};
}

/** Whether a component or artifact package is the inference core, under either of its names. */
function isInferenceCore(packageName: string): boolean {
	return (
		packageName === "opfield-inference" || packageName === "inference-core"
	);
}

function repositoryForPackage(env: Env, packageName: string): GitHubRepository {
	return isInferenceCore(packageName)
		? inferenceCoreRepository(env)
		: opfieldRepository(env);
}

async function readBoundedJson<T>(response: Response): Promise<T> {
	const contentLength = Number(response.headers.get("Content-Length") ?? "0");
	if (contentLength > RELEASE_LIST_LIMIT_BYTES)
		throw new Error("GitHub metadata response is too large");
	const body = await response.text();
	if (body.length > RELEASE_LIST_LIMIT_BYTES)
		throw new Error("GitHub metadata response is too large");
	return JSON.parse(body) as T;
}

function normalizeRelease(release: GitHubRelease): NormalizedRelease {
	const description = release.body ?? "";
	return {
		tag_name: release.tag_name,
		name: release.name ?? release.tag_name,
		description,
		body: description,
		html_url: release.html_url,
		published_at: release.published_at,
		prerelease: release.prerelease,
		_links: { self: release.html_url },
	};
}

function parseReleaseVersion(
	component: UpdateComponent,
	value: string,
): ParsedReleaseVersion | null {
	const clean = value.replace(/^v/, "");
	if (isInferenceCore(component)) {
		const match = CORE_VERSION_PATTERN.exec(clean);
		if (!match) return null;
		// Release lines replaced each other in the order of CORE_RELEASE_LINES. On the
		// same base version every build of a later line orders after every build of an
		// earlier one.
		const lineOffset = CORE_RELEASE_LINES.indexOf(match[4]) * 1_000_000;
		return {
			major: Number(match[1]),
			minor: Number(match[2]),
			patch: Number(match[3]),
			build: lineOffset + Number(match[5]),
			rc: null,
		};
	}
	const suffix =
		APP_COMPONENTS.has(component) || component === "witness-clickhouse-keeper"
			? ""
			: component === "relay" || component === "relay-supervisor"
				? "-relay"
				: component === "nginx-daemon"
					? "-nginx"
					: component === "docker-daemon"
						? "-docker"
						: component === "lease-watchdog"
							? "-watchdog"
							: "-monitoring";
	const optionalSuffix = suffix ? `(?:${suffix})?` : "";
	const match = new RegExp(
		`^(\\d+)\\.(\\d+)\\.(\\d+)(?:-rc\\.(\\d+))?${optionalSuffix}$`,
	).exec(clean);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		build: 0,
		rc: match[4] === undefined ? null : Number(match[4]),
	};
}

function compareReleaseVersions(
	a: ParsedReleaseVersion,
	b: ParsedReleaseVersion,
): number {
	for (const key of ["major", "minor", "patch", "build"] as const) {
		if (a[key] !== b[key]) return a[key] - b[key];
	}
	if (a.rc === b.rc) return 0;
	if (a.rc === null) return 1;
	if (b.rc === null) return -1;
	return a.rc - b.rc;
}

function parseUpdateChannel(value: string | null): UpdateChannel | null {
	if (value === null || value === "stable") return "stable";
	if (value === "preview") return "preview";
	return null;
}

function releaseMatchesChannel(
	channel: UpdateChannel,
	release: GitHubRelease,
	version: ParsedReleaseVersion,
): boolean {
	if (version.rc === null) return !release.prerelease;
	return channel === "preview" && release.prerelease;
}

function channelCandidates(
	component: UpdateComponent,
	releases: GitHubRelease[],
	channel: UpdateChannel,
): ReleaseCandidate[] {
	return releases
		.filter(
			(release) =>
				!release.draft && TAG_PATTERNS[component].test(release.tag_name),
		)
		.map((release) => ({
			release,
			version: parseReleaseVersion(component, release.tag_name),
		}))
		.filter(
			(candidate): candidate is ReleaseCandidate => candidate.version !== null,
		)
		.filter((candidate) =>
			releaseMatchesChannel(channel, candidate.release, candidate.version),
		);
}

/**
 * Whether older release pages can no longer change the answer. Without an installed version the
 * newest release is wanted, so any candidate settles it. Releases newer than the installed version
 * were published after it, so the search is settled once the list reaches a candidate that is not
 * newer than the installed version.
 */
function releaseSearchSettled(
	component: UpdateComponent,
	currentVersion: ParsedReleaseVersion | null,
	releases: GitHubRelease[],
	channel: UpdateChannel,
): boolean {
	const candidates = channelCandidates(component, releases, channel);
	if (!currentVersion) return candidates.length > 0;
	return candidates.some(
		(candidate) =>
			compareReleaseVersions(candidate.version, currentVersion) <= 0,
	);
}

function selectNextRelease(
	component: UpdateComponent,
	currentVersion: ParsedReleaseVersion | null,
	releases: GitHubRelease[],
	channel: UpdateChannel,
): { release: GitHubRelease; reason: NextUpdateResponse["reason"] } | null {
	const candidates = channelCandidates(component, releases, channel);
	if (candidates.length === 0) return null;

	if (!currentVersion) {
		const latest = candidates.sort((a, b) =>
			compareReleaseVersions(b.version, a.version),
		)[0];
		return latest ? { release: latest.release, reason: "latest" } : null;
	}

	if (isInferenceCore(component)) {
		const latest = candidates.sort((a, b) =>
			compareReleaseVersions(b.version, a.version),
		)[0];
		return latest && compareReleaseVersions(latest.version, currentVersion) > 0
			? { release: latest.release, reason: "latest" }
			: null;
	}

	const patch = candidates
		.filter(
			(candidate) =>
				candidate.version.major === currentVersion.major &&
				candidate.version.minor === currentVersion.minor &&
				compareReleaseVersions(candidate.version, currentVersion) > 0,
		)
		.sort((a, b) => compareReleaseVersions(b.version, a.version))[0];
	if (patch) return { release: patch.release, reason: "patch" };

	const higherMinor = candidates.filter(
		(candidate) =>
			candidate.version.major === currentVersion.major &&
			candidate.version.minor > currentVersion.minor,
	);
	if (higherMinor.length === 0) return null;
	const nextMinor = Math.min(
		...higherMinor.map((candidate) => candidate.version.minor),
	);
	const nextMinorCandidates = higherMinor.filter(
		(candidate) => candidate.version.minor === nextMinor,
	);
	const baselinePatch = Math.min(
		...nextMinorCandidates.map((candidate) => candidate.version.patch),
	);
	const baseline = nextMinorCandidates
		.filter((candidate) => candidate.version.patch === baselinePatch)
		.sort((a, b) => compareReleaseVersions(b.version, a.version))[0];
	return baseline
		? { release: baseline.release, reason: "minor-baseline" }
		: null;
}

function hasNextReleasePage(response: Response): boolean {
	return /;\s*rel="next"/.test(response.headers.get("Link") ?? "");
}

/**
 * Reads a repository's releases page by page until `settled` holds for what was read, GitHub has
 * no next page, or RELEASE_PAGE_LIMIT is reached. Returns null when GitHub fails.
 */
async function fetchReleases(
	env: Env,
	repository: GitHubRepository,
	fetcher: Fetcher,
	settled: (releases: GitHubRelease[]) => boolean,
): Promise<GitHubRelease[] | null> {
	const releases: GitHubRelease[] = [];
	for (let page = 1; page <= RELEASE_PAGE_LIMIT; page += 1) {
		const upstream = await fetcher(
			githubApiUrl(
				env,
				repository,
				`/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,
			),
			{ headers: githubHeaders(repository) },
		);
		if (!upstream.ok) {
			console.error(
				JSON.stringify({
					event: "github_releases_failed",
					repository: repository.name,
					page,
					status: upstream.status,
				}),
			);
			return null;
		}
		releases.push(...(await readBoundedJson<GitHubRelease[]>(upstream)));
		if (settled(releases) || !hasNextReleasePage(upstream)) break;
	}
	return releases;
}

function listedOnChannel(
	channel: UpdateChannel,
	release: GitHubRelease,
	stableOnly: boolean,
): boolean {
	return (
		!release.draft &&
		(stableOnly || channel === "stable" ? !release.prerelease : true)
	);
}

async function handleReleaseList(
	request: Request,
	env: Env,
	fetcher: Fetcher,
): Promise<Response> {
	const url = new URL(request.url);
	const channel = parseUpdateChannel(url.searchParams.get("channel"));
	if (!channel) return jsonResponse({ error: "invalid_channel" }, 400);
	const componentValue = url.searchParams.get("component");
	if (componentValue) {
		if (!(componentValue in TAG_PATTERNS))
			return jsonResponse({ error: "invalid_component" }, 400);
		const component = componentValue as UpdateComponent;
		const componentChannel = isInferenceCore(component) ? "stable" : channel;
		const current = url.searchParams.get("current");
		const currentVersion = current
			? parseReleaseVersion(component, current)
			: null;
		if (current && !currentVersion)
			return jsonResponse({ error: "invalid_current_version" }, 400);
		const releases = await fetchReleases(
			env,
			repositoryForPackage(env, component),
			fetcher,
			(read) =>
				releaseSearchSettled(component, currentVersion, read, componentChannel),
		);
		if (!releases)
			return jsonResponse({ error: "release_source_unavailable" }, 502);
		const selected = selectNextRelease(
			component,
			currentVersion,
			releases,
			componentChannel,
		);
		if (!selected) {
			return new Response(null, {
				status: 204,
				headers: { "Cache-Control": "no-store" },
			});
		}
		return jsonResponse(
			{
				component,
				current,
				target: normalizeRelease(selected.release),
				reason: selected.reason,
			} satisfies NextUpdateResponse,
			200,
			"public, max-age=30, s-maxage=60",
		);
	}
	// Each list reaches at least one release on the channel: an Opfield release from Opfield
	// repository, any stable build from the inference core repository.
	const [opfieldReleases, coreReleases] = await Promise.all([
		fetchReleases(env, opfieldRepository(env), fetcher, (read) =>
			read.some(
				(release) =>
					listedOnChannel(channel, release, false) &&
					APP_TAG_PATTERN.test(release.tag_name),
			),
		),
		fetchReleases(env, inferenceCoreRepository(env), fetcher, (read) =>
			read.some((release) => listedOnChannel(channel, release, true)),
		),
	]);
	if (!opfieldReleases || !coreReleases)
		return jsonResponse({ error: "release_source_unavailable" }, 502);
	const releases = [
		...opfieldReleases.filter((release) =>
			listedOnChannel(channel, release, false),
		),
		...coreReleases.filter((release) =>
			listedOnChannel(channel, release, true),
		),
	];
	return jsonResponse(
		releases.map(normalizeRelease),
		200,
		"public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
	);
}

function parseArtifactPath(
	pathname: string,
): { packageName: string; tag: string; artifactName: string } | null {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length !== 4 || !PRODUCT_NAMESPACES.has(segments[0] ?? ""))
		return null;
	const [, packageName, tag, artifactName] = segments.map((segment) =>
		decodeURIComponent(segment),
	);
	if (!packageName || !tag || !artifactName) return null;
	const tagPattern = TAG_PATTERNS[packageName];
	const artifactPattern = ARTIFACT_PATTERNS[packageName];
	if (!tagPattern?.test(tag) || !artifactPattern?.test(artifactName))
		return null;
	return { packageName, tag, artifactName };
}

function isTrustedAssetRedirect(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return (
		url.protocol === "https:" &&
		(url.hostname === "github.com" ||
			url.hostname === "objects.githubusercontent.com" ||
			url.hostname.endsWith(".githubusercontent.com"))
	);
}

function copyAssetHeaders(
	upstream: Response,
	asset: GitHubReleaseAsset,
): Headers {
	const headers = new Headers({
		"Content-Type":
			upstream.headers.get("Content-Type") ??
			asset.content_type ??
			"application/octet-stream",
		"Content-Disposition":
			upstream.headers.get("Content-Disposition") ??
			`attachment; filename="${asset.name.replaceAll('"', "")}"`,
		"Cache-Control": "public, max-age=3600, s-maxage=31536000, immutable",
		"Access-Control-Allow-Origin": "*",
		"X-Content-Type-Options": "nosniff",
	});
	for (const name of [
		"Content-Length",
		"Content-Range",
		"Accept-Ranges",
		"ETag",
		"Last-Modified",
	]) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

async function fetchAssetBinary(
	request: Request,
	env: Env,
	repository: GitHubRepository,
	asset: GitHubReleaseAsset,
	fetcher: Fetcher,
): Promise<Response> {
	if (request.method === "HEAD") {
		return new Response(null, {
			headers: {
				"Content-Type": asset.content_type || "application/octet-stream",
				"Content-Length": String(asset.size),
				"Content-Disposition": `attachment; filename="${asset.name.replaceAll('"', "")}"`,
				"Cache-Control": "public, max-age=3600, s-maxage=31536000, immutable",
				"Access-Control-Allow-Origin": "*",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}

	const range = request.headers.get("Range");
	const apiHeaders = githubHeaders(repository, "application/octet-stream");
	if (range) apiHeaders.set("Range", range);
	const assetResponse = await fetcher(
		githubApiUrl(env, repository, `/releases/assets/${asset.id}`),
		{
			headers: apiHeaders,
			redirect: "manual",
		},
	);

	let binaryResponse = assetResponse;
	if (assetResponse.status >= 300 && assetResponse.status < 400) {
		const location = assetResponse.headers.get("Location");
		if (!location || !isTrustedAssetRedirect(location)) {
			console.error(
				JSON.stringify({
					event: "github_asset_redirect_rejected",
					assetId: asset.id,
				}),
			);
			return jsonResponse({ error: "release_asset_unavailable" }, 502);
		}
		const redirectHeaders = new Headers();
		if (range) redirectHeaders.set("Range", range);
		binaryResponse = await fetcher(location, {
			headers: redirectHeaders,
			redirect: "follow",
		});
	}

	if (!binaryResponse.ok && binaryResponse.status !== 206) {
		console.error(
			JSON.stringify({
				event: "github_asset_failed",
				assetId: asset.id,
				status: binaryResponse.status,
			}),
		);
		return jsonResponse({ error: "release_asset_unavailable" }, 502);
	}
	return new Response(binaryResponse.body, {
		status: binaryResponse.status,
		headers: copyAssetHeaders(binaryResponse, asset),
	});
}

function parseInstallerPath(
	pathname: string,
): { tag: string | null; assetName: string } | null {
	if (pathname === "/" || pathname === "/install.sh")
		return { tag: null, assetName: "install.sh" };
	const segments = pathname.split("/").filter(Boolean);
	if (
		segments.length !== 5 ||
		!PRODUCT_NAMESPACES.has(segments[0] ?? "") ||
		segments[1] !== "releases"
	)
		return null;
	const [, , first, second, file] = segments.map((segment) =>
		decodeURIComponent(segment),
	);
	let tag: string | null;
	if (first === "latest" && second === "download") tag = null;
	else if (first === "download" && APP_TAG_PATTERN.test(second ?? ""))
		tag = second ?? null;
	else return null;
	if (!file || !INSTALLER_ASSET_PATTERN.test(file)) return null;
	return { tag, assetName: file };
}

async function handleInstaller(
	request: Request,
	env: Env,
	fetcher: Fetcher,
	path: { tag: string | null; assetName: string },
): Promise<Response> {
	const repository = opfieldRepository(env);
	const releaseResponse = await fetcher(
		githubApiUrl(
			env,
			repository,
			path.tag
				? `/releases/tags/${encodeURIComponent(path.tag)}`
				: "/releases/latest",
		),
		{ headers: githubHeaders(repository) },
	);
	if (releaseResponse.status === 404)
		return jsonResponse({ error: "release_not_found" }, 404);
	if (!releaseResponse.ok) {
		console.error(
			JSON.stringify({
				event: "github_release_failed",
				status: releaseResponse.status,
				tag: path.tag ?? "latest",
			}),
		);
		return jsonResponse({ error: "release_source_unavailable" }, 502);
	}
	const release = await readBoundedJson<GitHubRelease>(releaseResponse);
	const asset = release.assets.find(
		(candidate) => candidate.name === path.assetName,
	);
	if (!asset) return jsonResponse({ error: "artifact_not_found" }, 404);
	const response = await fetchAssetBinary(
		request,
		env,
		repository,
		asset,
		fetcher,
	);
	// The latest release moves; a tagged one does not.
	if (!path.tag && (response.ok || response.status === 206))
		response.headers.set("Cache-Control", LATEST_INSTALLER_CACHE_CONTROL);
	return response;
}

async function handleArtifact(
	request: Request,
	env: Env,
	fetcher: Fetcher,
): Promise<Response> {
	let path: ReturnType<typeof parseArtifactPath>;
	try {
		path = parseArtifactPath(new URL(request.url).pathname);
	} catch {
		return jsonResponse({ error: "invalid_artifact_path" }, 400);
	}
	if (!path) return jsonResponse({ error: "artifact_not_found" }, 404);
	const repository = repositoryForPackage(env, path.packageName);

	const releaseResponse = await fetcher(
		githubApiUrl(
			env,
			repository,
			`/releases/tags/${encodeURIComponent(path.tag)}`,
		),
		{
			headers: githubHeaders(repository),
		},
	);
	if (releaseResponse.status === 404)
		return jsonResponse({ error: "release_not_found" }, 404);
	if (!releaseResponse.ok) {
		console.error(
			JSON.stringify({
				event: "github_release_failed",
				status: releaseResponse.status,
				tag: path.tag,
			}),
		);
		return jsonResponse({ error: "release_source_unavailable" }, 502);
	}
	const release = await readBoundedJson<GitHubRelease>(releaseResponse);
	const asset = release.assets.find(
		(candidate) => candidate.name === path.artifactName,
	);
	if (!asset) return jsonResponse({ error: "artifact_not_found" }, 404);
	return fetchAssetBinary(request, env, repository, asset, fetcher);
}

export async function handleRequest(
	request: Request,
	env: Env,
	fetcher: Fetcher = fetch,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return jsonResponse({ error: "method_not_allowed" }, 405);
	}
	const pathname = new URL(request.url).pathname;
	if (pathname === "/health")
		return jsonResponse(
			{ ok: true, service: "opfield-updates" },
			200,
			"no-store",
		);
	const segments = pathname.split("/").filter(Boolean);
	const namespaced =
		segments.length === 2 && PRODUCT_NAMESPACES.has(segments[0] ?? "");
	if (namespaced && segments[1] === "releases")
		return handleReleaseList(request, env, fetcher);
	let installer: ReturnType<typeof parseInstallerPath>;
	try {
		installer = parseInstallerPath(pathname);
	} catch {
		return jsonResponse({ error: "invalid_artifact_path" }, 400);
	}
	if (installer) return handleInstaller(request, env, fetcher, installer);
	if (namespaced && segments[1] === LICENSE_ENDPOINTS_FILE)
		return handleInstaller(request, env, fetcher, {
			tag: null,
			assetName: LICENSE_ENDPOINTS_ASSET,
		});
	return handleArtifact(request, env, fetcher);
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handleRequest(request, env);
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "unhandled_request_error",
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			return jsonResponse({ error: "internal_error" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
