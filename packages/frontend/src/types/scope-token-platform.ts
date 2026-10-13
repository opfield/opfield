export const PLATFORM_TOKEN_SCOPES = [
  // Housekeeping
  {
    value: "housekeeping:view",
    label: "View Housekeeping",
    desc: "View housekeeping configuration, stats, and run history",
    group: "Housekeeping",
  },
  {
    value: "housekeeping:run",
    label: "Run Housekeeping",
    desc: "Manually run housekeeping tasks",
    group: "Housekeeping",
  },
  {
    value: "housekeeping:configure",
    label: "Configure Housekeeping",
    desc: "Edit housekeeping configuration and schedule",
    group: "Housekeeping",
  },
  // Opfield diagnostics
  {
    value: "diagnostics:view",
    label: "View Opfield Diagnostics",
    desc: "View Opfield's own host, process, database, cache, container, background job and API latency state and its history",
    group: "Diagnostics",
  },
  {
    value: "diagnostics:logs",
    label: "Read Opfield Logs",
    desc: "Read the logs of Opfield's own containers: the app, its database, cache, relay and registry",
    group: "Diagnostics",
  },
  // Licensing
  {
    value: "license:view",
    label: "View License",
    desc: "View Opfield license status and entitlement details",
    group: "Licensing",
  },
  {
    value: "license:manage",
    label: "Manage License",
    desc: "Activate, update, or remove the Opfield license",
    group: "Licensing",
  },
  // Notifications
  {
    value: "notifications:alerts:view",
    label: "View Alert Rules",
    desc: "View notification alert rules",
    group: "Notifications",
  },
  {
    value: "notifications:alerts:manage",
    label: "Manage Alert Rules",
    desc: "Create, edit, and delete notification alert rules",
    group: "Notifications",
  },
  {
    value: "notifications:webhooks:view",
    label: "View Webhooks",
    desc: "View notification webhooks and their delivery attempts",
    group: "Notifications",
  },
  {
    value: "notifications:webhooks:manage",
    label: "Manage Webhooks",
    desc: "Create, edit, test, and delete notification webhooks",
    group: "Notifications",
  },
  // Status Page
  {
    value: "status-page:view",
    label: "View Status Page",
    desc: "View status page configuration, exposed services, incidents, and preview",
    group: "Status Page",
  },
  {
    value: "status-page:manage",
    label: "Manage Status Page",
    desc: "Edit status page settings and exposed services",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:create",
    label: "Create Incidents",
    desc: "Create manual incidents and promote automatic incidents",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:update",
    label: "Update Incidents",
    desc: "Edit incident details and post incident timeline updates",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:resolve",
    label: "Resolve Incidents",
    desc: "Resolve active status page incidents",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:delete",
    label: "Delete Past Incidents",
    desc: "Delete resolved status page incidents",
    group: "Status Page",
  },
  // Features
  {
    value: "ai:workspace:use",
    label: "Use AI Workspace",
    desc: "Use the AI Workspace interface and embedded assistant",
    group: "Features",
  },
  {
    value: "feat:ai:use",
    label: "Use Opfield Inference",
    desc: "Use Opfield Inference and view personal inference usage",
    group: "Features",
  },
  {
    value: "feat:ai:configure",
    label: "Configure AI",
    desc: "Configure AI settings and providers",
    group: "Features",
  },
  {
    value: "ai:skills:manage",
    label: "Manage AI Skills",
    desc: "Create, edit, enable, disable, and delete AI Workspace skills",
    group: "Features",
  },
  {
    value: "ai:sandbox:use",
    label: "Use Sandbox Runner",
    desc: "Run bounded AI sandbox jobs",
    group: "Features",
  },
  {
    value: "ai:sandbox:tier:medium",
    label: "Use Medium Sandbox Tier",
    desc: "Run AI sandbox jobs with medium resource limits",
    group: "Features",
  },
  {
    value: "ai:sandbox:tier:high",
    label: "Use High Sandbox Tier",
    desc: "Run AI sandbox jobs with high resource limits",
    group: "Features",
  },
  {
    value: "ai:sandbox:manage",
    label: "Manage Sandbox Jobs",
    desc: "View and kill AI sandbox jobs",
    group: "Features",
  },
  {
    value: "mcp:use",
    label: "Use MCP",
    desc: "Allow this user account to access the remote MCP server with OAuth",
    group: "Features",
  },
  // Inference administration.
  {
    value: "inference:providers:view",
    label: "View Inference Providers",
    desc: "View inference providers, connections, discovery, and quota",
    group: "Inference",
  },
  {
    value: "inference:providers:manage",
    label: "Manage Inference Providers",
    desc: "Connect, update, synchronize, route, and disconnect inference providers",
    group: "Inference",
  },
  {
    value: "inference:models:manage",
    label: "Manage Inference Models",
    desc: "Create, publish, replace, and delete inference models",
    group: "Inference",
  },
  {
    value: "inference:limits:manage",
    label: "Manage Inference Limits",
    desc: "Configure default and per-user inference budgets",
    group: "Inference",
  },
  {
    value: "inference:usage:view",
    label: "View Inference Usage",
    desc: "View system-wide and per-user inference usage",
    group: "Inference",
  },
] as const;
