// Turns the exported DOM snapshots (out/dom/*.json) and the compiled stylesheet
// (out/gateway.css) into the foss-design canvas `gateway` in the repository's
// .design folder: one HTML screen per snapshot, laid out by canvas.json.
// The viewer (`design preview`) switches every screen between light and dark.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(frontendRoot, "../..");
const outDir = path.join(here, "out");
const domDir = path.join(outDir, "dom");
const publicDir = path.join(frontendRoot, "public");
export const CANVAS_ID = "gateway";
const canvasDir = path.join(repoRoot, ".design/canvas", CANVAS_ID);

const SECTION_COLUMNS = 4;

/**
 * Canvas pages in order; `group` is ScreenSpec.group. Each section lists id prefixes: a
 * screen belongs to the section with the longest prefix that equals its id or starts it
 * followed by "-". Inside a section, screens named exactly by a prefix come first in list
 * order, then the rest alphabetically. Screens no section claims land in a trailing
 * "Other" section of their page, with a warning.
 */
const PAGES = [
  {
    id: "overview",
    title: "Overview",
    group: "Overview",
    subject: "dashboard and assistant",
    sections: [
      { title: "Dashboard", match: ["dashboard"] },
      { title: "AI Workspace", match: ["overview-ai-chat", "overview-ai"] },
    ],
  },
  {
    id: "ingress",
    title: "Routes & Pages",
    group: "Ingress",
    subject: "routes, domains, access lists, templates and Pages",
    sections: [
      { title: "Routes", match: ["ingress-routes"] },
      { title: "Create Route", match: ["ingress-routes-new"] },
      { title: "Route · Details", match: ["ingress-route-details"] },
      { title: "Route · Settings", match: ["ingress-route-settings"] },
      { title: "Route · Advanced and Raw Config", match: ["ingress-route-advanced", "ingress-route-raw"] },
      { title: "Route · Link Runtime", match: ["ingress-route-link-runtime"] },
      { title: "Route · Logs", match: ["ingress-route-logs"] },
      { title: "Route · Maintenance", match: ["ingress-route-maintenance"] },
      {
        title: "Domains",
        match: ["ingress-domains", "ingress-domain-dialog-create-subfolder", "ingress-domain-dialog-delete-folder"],
      },
      { title: "Add Domain", match: ["ingress-dialog-add-domain"] },
      {
        title: "Domain · Details",
        match: ["ingress-domain-details", "ingress-domain-dialog", "ingress-domain-ingress-migration"],
      },
      { title: "Access Lists", match: ["ingress-access-lists", "ingress-dialog-access-list"] },
      {
        title: "Templates · Nginx Config",
        match: ["ingress-templates-nginx", "ingress-nginx-template-new", "ingress-nginx-template-edit"],
      },
      { title: "Templates · PKI Certificates", match: ["ingress-templates-pki"] },
      { title: "Pages", match: ["ingress-pages", "ingress-dialog-create-page-project"] },
      { title: "Pages project · Deployments", match: ["ingress-pages-project-deployments"] },
      { title: "Pages project · Source", match: ["ingress-pages-project-source"] },
      { title: "Pages project · Builds", match: ["ingress-pages-project-builds"] },
      { title: "Pages project · Tags", match: ["ingress-pages-project-tags"] },
      { title: "Pages project · Deploy tokens", match: ["ingress-pages-project-tokens"] },
      { title: "Pages project · Configuration", match: ["ingress-pages-project-configuration"] },
      { title: "Pages project · Dialogs", match: ["ingress-pages-project"] },
      { title: "Pages settings", match: ["ingress-pages-settings"] },
    ],
  },
  {
    id: "certificates",
    title: "Certificates",
    group: "Certificates",
    subject: "SSL certificates, CAs and issued certificates",
    sections: [
      { title: "SSL certificates", match: ["certs-ssl-certificates"] },
      { title: "Add SSL Certificate", match: ["certs-dialog-ssl"] },
      { title: "Certificate Authorities", match: ["certs-cas", "certs-ca-detail"] },
      { title: "Create CA", match: ["certs-dialog-ca"] },
      { title: "Certificates", match: ["certs-certificates", "certs-certificate-detail"] },
      { title: "Issue Certificate", match: ["certs-dialog-issue"] },
      { title: "Create Template", match: ["certs-dialog-template"] },
    ],
  },
  {
    id: "docker",
    title: "Docker",
    group: "Docker",
    subject: "containers, deployments, Compose, images, volumes and networks",
    sections: [
      {
        title: "Docker",
        match: [
          "docker-containers",
          "docker-compose-projects",
          "docker-images",
          "docker-volumes",
          "docker-networks",
          "docker-tasks",
          "docker-builds",
        ],
      },
      { title: "Docker dialogs", match: ["docker-dialog"] },
      { title: "Container", match: ["docker-container-detail", "docker-container"] },
      { title: "Deployment", match: ["docker-deployment-overview", "docker-deployment"] },
      { title: "Compose project", match: ["docker-compose-project", "docker-compose"] },
      { title: "Volume", match: ["docker-volume"] },
      { title: "Tool windows", match: ["docker-tool"] },
    ],
  },
  {
    id: "nodes",
    title: "Nodes",
    group: "Nodes",
    subject: "nodes and hosting",
    sections: [
      { title: "Nodes", match: ["nodes-list", "nodes-providers"] },
      { title: "Node dialogs", match: ["nodes-dialog"] },
      { title: "Node detail", match: ["node-detail", "nodes-detail"] },
      { title: "Hosting integration", match: ["nodes-hosting-overview", "nodes-hosting"] },
      { title: "Tool windows", match: ["nodes-tool"] },
    ],
  },
  {
    id: "data",
    title: "Databases & Storage",
    group: "Data",
    subject: "databases and object storage",
    sections: [
      { title: "Databases", match: ["databases-list", "data-database-deploy-dialog"] },
      { title: "Database", match: ["database-detail", "data-database"] },
      { title: "Storage", match: ["storage", "data-storage-add-dialog"] },
      { title: "Storage detail", match: ["data-storage-overview", "data-storage"] },
      { title: "Availability", match: ["data-availability"] },
    ],
  },
  {
    id: "observability",
    title: "Logs & Alerts",
    group: "Observability",
    subject: "logging, notifications, status page and audit",
    sections: [
      {
        title: "Logging",
        match: [
          "ops-logging-environments",
          "ops-logging-environment-dialog",
          "logging-explorer",
          "ops-logging-environment-settings",
          "ops-logging-environment-tokens",
          "ops-logging-schemas",
          "ops-logging-schema",
        ],
      },
      {
        title: "Notifications",
        match: [
          "notifications-alerts",
          "ops-alert-rule-dialog",
          "ops-notifications-webhooks",
          "ops-webhook-dialog",
          "ops-notifications-deliveries",
          "ops-notifications-siem",
          "ops-notifications-siem-deliveries",
        ],
      },
      { title: "Status Page", match: ["ops-status"] },
      { title: "Audit", match: ["ops-audit"] },
    ],
  },
  {
    id: "administration",
    title: "Administration",
    group: "Administration",
    subject: "settings, users, groups and profile",
    sections: [
      { title: "Settings", match: ["settings", "admin-settings"] },
      { title: "Users", match: ["admin-users", "admin-user"] },
      { title: "Groups", match: ["admin-groups", "admin-group"] },
      { title: "Profile", match: ["profile", "admin-profile-authorizations", "admin-api-token-dialog"] },
    ],
  },
  {
    id: "sign-in",
    title: "Sign-in",
    group: "Sign-in",
    subject: "sign-in, OAuth and error pages",
    sections: [
      {
        title: "Sign-in",
        match: [
          "signin-login",
          "signin-login-email",
          "signin-reset-password",
          "signin-callback",
          "signin-callback-error",
          "signin-oauth-consent",
          "signin-oauth-error",
          "signin-blocked",
        ],
      },
    ],
  },
  {
    id: "states",
    title: "States",
    group: "States",
    subject: "dialogs, loading, empty and pending states",
    sections: [
      {
        title: "States",
        match: [
          "state-page-loader",
          "state-empty",
          "state-create-route-dialog",
          "state-deploy-dialog",
          "state-destructive-confirm",
          "state-button-pending",
          "state-ai-side-panel",
        ],
      },
    ],
  },
];

/**
 * The product picks its theme from a `.light` or `.dark` class on <html> and falls back to
 * the system preference; the viewer only sets `dark` and `data-theme`. Mirror the viewer's
 * light theme as `.light` so a dark OS does not paint light frames dark.
 */
const THEME_SYNC = `<script>
(() => {
  const root = document.documentElement;
  const sync = () =>
    root.classList.toggle("light", root.dataset.theme !== "dark" && !root.classList.contains("dark"));
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
  sync();
})();
</script>`;

const escapeText = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `src="/file.png?v=2"` points into the app's public folder: copy it into the canvas assets. */
function localizeAssets(body, copied) {
  return body.replace(/src="\/([^"?]+)(\?[^"]*)?"/g, (match, file) => {
    const source = path.join(publicDir, file);
    if (!fs.existsSync(source)) return match;
    const target = path.join(canvasDir, "assets", file);
    if (!copied.has(file)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied.add(file);
    }
    return `src="../assets/${file}"`;
  });
}

function screenHtml(screen, copied) {
  const styles = Array.from(new Set(screen.styles.map((css) => css.trim()).filter(Boolean)));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeText(screen.title)}</title>
${THEME_SYNC}
<link rel="stylesheet" href="./gateway.css">
<style>
body{margin:0}
${styles.join("\n")}
</style>
</head>
<body>
${localizeAssets(screen.body, copied)}
</body>
</html>
`;
}

/** The source the screens were rendered from: the commit, its branch, and a mark for local changes. */
function sourceRevision() {
  try {
    const head = execSync("git rev-parse --short HEAD", { cwd: here }).toString().trim();
    const branch = execSync("git branch --show-current", { cwd: here }).toString().trim();
    const dirty = execSync("git status --porcelain -- ../../src", { cwd: here }).toString().trim();
    const revision = dirty ? `${head} with local changes` : head;
    return branch && branch !== "main" ? `branch ${branch}, ${revision}` : revision;
  } catch {
    return "unknown";
  }
}

function screenDescription(screen) {
  const lines = [...screen.notes];
  if (screen.placeholders.length > 0) {
    lines.push(`Hatched boxes (not painted by the exporter): ${screen.placeholders.join(", ")}.`);
  }
  if (screen.unmocked.length > 0) {
    lines.push(`Requests without a fixture: ${screen.unmocked.map((entry) => `${entry.method} ${entry.path}`).join(", ")}.`);
  }
  return lines.join(" ");
}

/** Assigns every screen of a page to its section, in section order. */
function layoutPage(page, pageScreens, warnings) {
  const owner = (id) => {
    let best = null;
    page.sections.forEach((section, sectionIndex) => {
      section.match.forEach((entry, entryIndex) => {
        if (id !== entry && !id.startsWith(`${entry}-`)) return;
        if (!best || entry.length > best.entry.length) best = { sectionIndex, entryIndex, entry };
      });
    });
    return best;
  };
  const rows = page.sections.map(() => []);
  const other = [];
  for (const screen of pageScreens) {
    const found = owner(screen.id);
    if (!found) {
      other.push(screen);
      warnings.push(`${screen.id}: no section on page "${page.title}" claims it`);
      continue;
    }
    const exact = page.sections[found.sectionIndex].match.indexOf(screen.id);
    rows[found.sectionIndex].push({ screen, rank: exact === -1 ? Number.MAX_SAFE_INTEGER : exact });
  }
  const sections = page.sections
    .map((section, index) => ({
      title: section.title,
      screens: rows[index]
        .sort((a, b) => a.rank - b.rank || a.screen.id.localeCompare(b.screen.id))
        .map((row) => row.screen),
    }))
    .filter((section) => section.screens.length > 0);
  if (other.length > 0) {
    sections.push({ title: "Other", screens: other.sort((a, b) => a.id.localeCompare(b.id)) });
  }
  return sections;
}

export function writeCanvas() {
  const designRoot = path.join(repoRoot, ".design");
  if (!fs.existsSync(path.join(designRoot, "design.json"))) {
    throw new Error(`no foss-design project at ${designRoot}: run \`design init\` in ${repoRoot}`);
  }
  const screens = fs
    .readdirSync(domDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(domDir, file), "utf8")));

  fs.rmSync(canvasDir, { recursive: true, force: true });
  const screensDir = path.join(canvasDir, "screens");
  fs.mkdirSync(screensDir, { recursive: true });
  fs.copyFileSync(path.join(outDir, "gateway.css"), path.join(screensDir, "gateway.css"));
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith(".woff2")) fs.copyFileSync(path.join(outDir, file), path.join(screensDir, file));
  }

  const warnings = [];
  const copied = new Set();
  for (const screen of screens) {
    if (screen.unmocked.length > 0) {
      warnings.push(`${screen.id}: ${screen.unmocked.length} requests had no fixture`);
    }
    if (screen.reparse && screen.reparse.original !== screen.reparse.reparsed) {
      warnings.push(
        `${screen.id}: markup re-parses to ${screen.reparse.reparsed} elements (rendered ${screen.reparse.original})`
      );
    }
    fs.writeFileSync(path.join(screensDir, `${screen.id}.html`), screenHtml(screen, copied));
  }

  const source =
    `Rendered from the real frontend code (${sourceRevision()}, ${new Date().toISOString().slice(0, 10)}) ` +
    "with fixture data only. Regenerate: `pnpm --filter frontend design-screens:export`.";
  const pages = [];
  for (const page of PAGES) {
    const pageScreens = screens.filter((screen) => screen.group === page.group);
    if (pageScreens.length === 0) continue;
    pages.push({
      id: page.id,
      title: page.title,
      description: `Opfield console: ${page.subject}. ${source}`,
      sections: layoutPage(page, pageScreens, warnings).map((section, index) => ({
        id: `${page.id}-${index + 1}`,
        title: section.title,
        columns: SECTION_COLUMNS,
        items: section.screens.map((screen) => {
          const description = screenDescription(screen);
          return {
            id: screen.id,
            src: `screens/${screen.id}.html`,
            title: screen.title,
            ...(description ? { description } : {}),
            width: screen.width,
            height: screen.height,
          };
        }),
      })),
    });
  }
  const unplaced = screens.filter((screen) => !PAGES.some((page) => page.group === screen.group));
  for (const screen of unplaced) warnings.push(`${screen.id}: group "${screen.group}" has no canvas page`);

  const canvas = {
    title: "Opfield screens",
    description: "Every console screen, rendered from the product code with fixture data.",
    system: false,
    pages,
  };
  fs.writeFileSync(path.join(canvasDir, "canvas.json"), `${JSON.stringify(canvas, null, 2)}\n`);
  return { screens: screens.length - unplaced.length, pages: pages.length, dir: canvasDir, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = writeCanvas();
  console.log(`canvas ${CANVAS_ID}: ${result.screens} screens on ${result.pages} pages → ${result.dir}`);
  for (const warning of result.warnings) console.warn(warning);
}
