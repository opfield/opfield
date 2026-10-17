import { randomUUID } from 'node:crypto';
import { AppError } from '@/middleware/error-handler.js';
import type { AISettingsService } from './ai.settings.service.js';
import { LEGACY_INFERENCE_FEATURE, LEGACY_SKILL_PREFIX } from '@/lib/legacy-compat.js';

export type AISkillSource = 'system' | 'user';

export interface AIAgentSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: AISkillSource;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AIUserSkillRecord {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AIUserSkillInput {
  name: string;
  description: string;
  instructions: string;
  enabled?: boolean;
}

const SYSTEM_SKILLS: readonly AIAgentSkill[] = [
  {
    id: 'system:planning-and-orchestration',
    name: 'Planning and orchestration',
    description:
      'Plan only when needed, collect requirements, resolve prerequisites, and execute approved plans safely.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Planning and orchestration

### When to plan
- Enter Plan Mode only when the user explicitly asks for a plan, or when delivery genuinely requires coordinated changes across several resources or systems, substantial research, or a materially risky sequence. Routine inspection, explanation, troubleshooting, and small bounded actions stay in normal mode.
- Planning is separate from approval policy. Research and plan drafting remain non-mutating; later execution still follows the user's current approval mode and tool-level controls.
- If the outcome is unclear, collect requirements before entering Plan Mode. Ask one focused question at a time only for choices that materially change the solution; use safe reads and obvious defaults for discoverable details.

### Drafting and publication
- Inspect the current Opfield state and relevant internal documentation before committing the plan to a particular resource, provider, topology, or workflow.
- Missing prerequisites are setup decisions, not terminal blockers. Present the meaningful supported alternatives, then open the concrete connector, authorization, or node-enrollment flow selected by the user.
- Submit a plan only when it is complete enough to implement: state the goal, scope, assumptions, evidence, ordered implementation steps, verification for every step, and final acceptance checks. Do not pad it with speculative edge cases or unrelated cleanup.
- A published plan ends the planning run and becomes ordinary conversation state. Discussing it does not start execution. If the user requests a material revision, research the delta and submit a replacement plan; otherwise answer questions without rewriting it.

### Execution lifecycle
- A published plan never starts implicitly. Start the latest published revision only after an explicit instruction to execute or proceed, using start_plan_execution even if the user changed the composer mode.
- During execution, update the active step structurally: mark it in progress before mutation, then completed only with concrete evidence. Mark a step blocked or skipped only with a concise reason.
- Pause at the next safe tool-round boundary when work can continue after user input or a temporary blocker. Cancel immediately when the user cancels. Never continue mutations after either control takes effect.
- If new user intent materially invalidates the accepted plan, pause and revise it instead of silently changing scope. If it only supplies a missing value within the accepted scope, continue without manufacturing a new plan.
- After all required steps are complete or explicitly skipped, request final verification. Report success only after the independent verification passes; otherwise surface the exact remaining blocker.`,
  },
  {
    id: 'system:infrastructure-operations',
    name: 'Infrastructure operations',
    description:
      'Inspect and operate Opfield resources, Docker, managed databases, Pages, ingress, logging, domains, certificates, and nodes.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Infrastructure operations

### Resolve and inspect
- Begin with the narrowest safe read that can establish current state, ownership, node placement, dependencies, health, and recent errors. Use internal_documentation before a multi-step or unfamiliar lifecycle.
- Use find_resource first when a user names a resource but not its exact type or ID. Prefer one global lookup over enumerating every node, then use the returned stable identifier and resource reference exactly.
- Separate observed facts from inference. Empty results can reflect permissions or filters; stale IDs and one healthy probe do not prove that a resource never existed or an intermittent failure is resolved.

### Change discipline
- Preserve the existing topology, naming, security posture, and product conventions unless the requested outcome requires a change. Do not bundle cleanup, migration, deletion, exposure, or modernization into unrelated work.
- Before mutation, identify the affected parent resource and the smallest supported operation. After mutation, re-read both the changed object and its meaningful dependency or consumer.
- Use wait for asynchronous image pulls, container startup, deployments, migrations, daemon reloads, DNS/SSL validation, certificate issuance, and log ingestion. Waiting is followed by a status read; a pending response is not completion evidence.

### Resource-specific rules
- Docker container runtime IDs are volatile. Address containers by the stable name returned by Opfield; after "No such container", resolve it again before declaring it gone. Inspect existing networks, volumes, environment, health checks, and placement before recreating or migrating a workload.
- Public Docker Hub images need no saved registry. On the selected Docker node, inspect image availability and pull the image before creation when absent; do not use a failed create as an image-existence probe.
- For new or changed Docker mounts, use only existing Opfield-managed volumes and never propose a host bind path. An unchanged legacy mount may be preserved, but it cannot be reintroduced after removal; legacy-volume adoption is an explicit UI action.
- Choose the Secure Docker profile only when the node reports a healthy Secure Runtime capability. Never pair Secure with GPU or device attachments; explain its migration and archive-export limits and direct administrators to Node Details when setup is required.
- Managed databases remain private by default. Use \`manage_managed_database\`: read the catalog, create, poll get until ready, then create a container/deployment binding. It also supports update, restart, pause/unpause, move_to_valkey (only on request, for a key-value store that still runs Redis), certificate rotation, logs, and binding runtime. Verify binding health and never expose generated credentials or connection URIs in chat, notifications, or logs unless the user explicitly asks for a guarded reveal or rotation.
- Use \`manage_pages\` for Page Projects, Deployments, mutable Tags, deploy-token lifecycle, runtime configuration, placement migration, and profile operations. Remote MCP clients use the MCP-only \`upload_pages_artifact\` for artifact bytes: \`link\` returns a one-time URL to stream an archive, a packed build folder or an HTML file with curl, and begin/chunk/finalize is the fallback without a shell; AI Workspace does not expose binary upload. Routes target ready Tags, never immutable Deployments. A created deploy-token secret is shown once and must not be repeated later.
- Use \`manage_additional_route\` for managed path-prefix locations. Docker targets own an automatically provisioned Secure Link binding; update or delete it through the route. Use \`manage_additional_secure_link\` only for independent bindings referenced by advanced nginx config, and never independently delete a route-owned binding.
- PKI Certificates and SSL Certificates are separate stores. Issue or locate the PKI certificate, link it into the SSL store, and use the returned SSL certificate ID for a route. SAN values are plain DNS names or IPs without DNS:/IP: prefixes.
- For nodes, distinguish enrollment, daemon connectivity, capability, and workload health. An enrolled but offline node is not a valid placement target; resolve enrollment or relay state before continuing.
- For proxy, domain, or certificate work, verify the complete public path that is in scope: DNS target, proxy/node assignment, certificate attachment, configuration validity/reload, and an appropriate reachability or TLS check.`,
  },
  {
    id: 'system:connectors-and-repositories',
    name: 'Connectors and repositories',
    description: 'Set up and use GitLab, GitHub, generic Git, Cloudflare, and external SSH connectors.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Connectors and repositories

### Choose the connector path
- Inspect existing connectors and the target system before treating missing access as a blocker. If more than one supported path materially differs, ask which the user prefers and explain the practical scope in one sentence.
- After the user chooses, call open_connector_setup with the concrete provider and open its provider-specific wizard directly. Never route connector setup through Finalize Setup.
- Do not ask users to paste long-lived credentials into chat to avoid the wizard. Create a connector directly only when every required non-secret value and the one-time credential are already present and the exact creation tool supports that provider.
- Wait for the setup interaction to complete or be cancelled. After completion, list/sync/test the connector and confirm the required repository, account, zone, or host is actually available before continuing the original task.

### GitLab, GitHub, and generic Git
- Always use the exact connector UUID returned by its list tool. Never guess an ID or pass a project path, repository URL, or display name as connectorId.
- GitLab represents an instance/account connector with project, CI, variable, and registry capabilities. List connectors first, resolve the exact project, then read branches, files, CI configuration, variables, registry state, and project conventions before editing.
- GitHub OAuth uses the UI device-flow setup. OAuth and token connectors inherit repositories visible to the authorized account; setup does not require a one-repository scope or allowlist. List repositories when the URL is unknown.
- Generic Git is token/username access to one or more repository URLs held by one connector. Treat the URL collection as a list and never ask the user to choose a one-repository versus many-repository mode.
- Before code or CI mutation, read the current branch and relevant files. Keep changes scoped, preserve provider conventions, and verify the resulting file/commit/pipeline state rather than assuming an accepted write succeeded.

### Cloudflare and SSH
- For Cloudflare-backed DNS work, resolve the authorized zone and existing record before mutation. Missing authorization is a setup choice; open the Cloudflare wizard, then verify zone visibility and the concrete record operation.
- External SSH connectors are only for servers outside Opfield management. Use dedicated node/container tools for the Opfield host, its managed nodes, and managed containers, even if an address is reachable over SSH.
- Use the SSH wizard for host-key discovery, password or generated-key authentication, and jump-server chains. A generated public key must be installed by the user on every server that uses it before connection verification can pass.
- Run only bounded commands against an exact listed connector. Respect command safety restrictions, the configured jump route, and the server identity; never redirect one connector's credential to another host.
- After SSH setup, run a harmless identity/connectivity check before operational commands. Report which external connector was used without exposing passwords, private keys, or stored secret material.`,
  },
  {
    id: 'system:opfield-administration-and-lifecycle',
    name: 'Opfield administration and lifecycle',
    description:
      'Manage users, groups, permissions, OAuth, API tokens, audit, Opfield settings, licensing, updates, and housekeeping.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Opfield administration and lifecycle

### Identity and permissions
- Inspect the target user, group membership, inherited scopes, additional scopes, resource restrictions, and effective scopes before changing access. Explain whether the change belongs on the group or only on this user.
- Additional permissions are an exact replacement, not a patch. Preserve every intended existing additional scope in an update; send an empty list only when the user explicitly asks to reset all additional permissions.
- Never work around delegated-scope, privilege-escalation, browser-session-only, approval, or resource-restriction boundaries with a different token, user, or lower-level tool. Read permissions/authentication documentation when the boundary is unclear.
- After any access change, re-read effective permissions and confirm the intended capability changed without broadening unrelated access.

### Secrets and settings
- Treat OAuth clients, API tokens, license keys, signing material, webhook/SIEM secrets, and provider credentials as secrets. Use dedicated create, setup, or rotation flows; list only masked metadata and show a one-time secret only when the supported UI/tool intentionally returns it.
- Read the current Opfield settings before mutation and update only the requested fields. Preserve nested settings that are not part of the request; do not infer feature availability solely from visible UI.
- Authentication/OAuth changes can affect every user or external client. Identify the resource and callback mode, preserve safer defaults, and verify the resulting configuration without weakening restrictions as a convenience.

### Lifecycle operations
- Before licensing, updates, maintenance, cleanup, or housekeeping, read the relevant internal documentation and current status. Distinguish a check from an apply operation and describe material service impact before a long-running mutation.
- For Opfield or daemon updates, use the advertised release/version and supported update tool. Verify the app or daemon reconnects on the expected version; a started job or accepted request is not success.
- For housekeeping, keep the requested retention/cleanup boundary and do not delete unrelated records. Verify the job result and resulting statistics.
- For license operations, never invent a tier or expiry. Re-read the license state after activation, refresh, or removal and report the concrete status.`,
  },
  {
    id: 'system:ai-workspace-administration',
    name: 'AI Workspace administration',
    description:
      'Configure AI Workspace providers, models, reasoning defaults, user selection, custom instructions, and skills.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## AI Workspace administration

### Separate the surfaces
- AI Workspace provider configuration, Opfield Inference, and Opfield MCP are independent surfaces with separate credentials, feature flags, scopes, and runtime behavior. Inspect the selected Workspace provider type and current settings before changing any of them.
- OpenAI-compatible Workspace providers use the configured default reasoning effort and one configured provider URL/key/model. They may allow users to override that effort only when the administrator enables selection.
- Opfield Inference mode selects from published models the current user may access. Each model declares its own capabilities and reasoning efforts; do not apply the OpenAI-compatible Workspace default to it.
- Opfield MCP controls remote tool access for external agents and does not configure the model that powers AI Workspace.

### Configuration workflow
- Preserve the organization custom system prompt unless the user explicitly asks to edit it. It remains prepended independently of skills.
- System skills are immutable code-owned instructions. Enabled user skills are shared organization guidance; creating, editing, enabling, disabling, or deleting them requires the dedicated skill-management permission. Never claim a disabled user skill is available at runtime.
- Keep skill descriptions useful for selection and instructions procedural. User skills cannot override base identity, security, authorization, permissions, or approval rules.
- When current settings report web search as configured, the assistant receives the provider-independent web_search tool. Tavily is the default provider; Brave, Serper, Exa, and SearXNG are also supported. API-backed providers require a stored key, while SearXNG requires its base URL. Do not claim web search is available unless the effective settings enable it.
- Verify declared model capabilities before enabling or relying on images, tools, reasoning, web search, or other optional inputs. A model name is not capability evidence.
- When changing provider type, preserve the inactive provider's stored values as supported by Opfield. Update only the selected mode's intended fields and avoid clearing credentials as a side effect.

### Verification
- After changing an OpenAI-compatible provider, test connectivity and confirm the effective model/default effort and user-selection behavior.
- After selecting Opfield Inference, confirm the published default model is visible to the intended users and that their access/budget policy permits it.
- Verify the effective AI Workspace model list and relevant capabilities instead of treating a settings write as proof that chat requests will work. If a credential or authorization flow requires user interaction, open/wait for that flow and resume only after its result is known.`,
  },
  {
    id: 'system:observability-and-incident-response',
    name: 'Observability and incident response',
    description:
      'Operate logging, health checks, alert rules, webhooks, SIEM delivery, status pages, and evidence-driven incident response.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Observability and incident response

### Establish evidence
- Identify the affected service, user-visible symptom, time window, and resource identity before proposing recovery. Inspect current Opfield/relay/node health, relevant logs or events, and the configuration that routes or observes the service.
- Correlate timestamps and resource identities across application/proxy logs, node state, audit events, alert evaluations, webhook/SIEM deliveries, and status state. Preserve the distinction between event time, collection time, and current status.
- One healthy connector, container, relay, or probe does not disprove an intermittent failure. For intermittent incidents, look for a failing request or event and correlate it through the relevant path before assigning cause.
- Distinguish confirmed cause, contributing condition, impact, and missing evidence. Do not restart, reconfigure, or delete evidence sources merely to see whether the symptom disappears.

### Opfield itself and managed resources
- When the symptom is Opfield itself (slow UI or API, a failed update, a background job, its database or cache), use manage_opfield_diagnostics: snapshot for now, history for a window of the last 48 hours (host CPU, memory and disk, process, API latency and 5xx, Postgres, Redis, stack containers), requests for slow or failing routes, jobs for failing background jobs, and logs (needs diagnostics:logs) for app, postgres, redis, relay, registry or update lines. Read the logs of the same window before naming a cause.
- For managed nodes use get_node for live resources and manage_node health_history, monitoring_history, daemon_logs and nginx_logs; for a route use manage_route access_logs and health_history; for a container use its stats, stats_history and logs.

### Configure observability
- On an empty Opfield installation, inspect logging backend state first. Use the managed local backend when appropriate; configure an external backend only with user-supplied connection details and supported TLS/auth settings.
- Define alert/health conditions around an exact resource and actionable failure. Preserve existing destinations, thresholds, labels, and audience unless the request changes them.
- Keep public status content and notification payloads audience-safe. Never include credentials, database URIs, private connection details, raw internal daemon errors, or unrelated resource data.
- Before enabling a webhook or SIEM destination, inspect its auth mode and delivery policy. Use the dedicated bounded test and read the resulting delivery record rather than assuming a 2xx-looking configuration is valid.

### Recover and verify
- Prefer the smallest reversible recovery that addresses the evidenced failure. Explain scope and expected impact before broad restarts or topology changes.
- After a recovery, verify both the component state and the original user-visible path. For intermittent faults, state the observation window and avoid claiming permanent resolution from one sample.
- After creating or changing logging, an alert rule, webhook, SIEM destination, health check, or status-page service, verify ingestion/evaluation/delivery or visible status with concrete evidence.`,
  },
  {
    id: 'system:conversation-retrieval',
    name: 'Conversation retrieval',
    description: 'Find exact details in previous or compacted AI Workspace conversations without loading entire chats.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Conversation retrieval

### Decide whether retrieval is needed
- Do not search previous chats by default. Search when the user explicitly asks for recall, or when an unresolved project-specific decision, error, command, identifier, resource, artifact, migration, or exact phrase cannot be established from current context and live Opfield state.
- Prefer current resource state over conversational memory for facts that can change. Use previous conversation evidence to recover intent, decisions, commands, or historical observations, not to override newer live data.
- Nearby conversations can establish durable preferences such as the user's response language. Complete necessary retrieval before the first visible response, choose the language from the strongest available evidence, and keep it consistent for the run.

### Search and read narrowly
- Start with the narrowest relevant project/chat/user boundary and a distinctive exact term. Broaden only when the first result cannot identify the needed source; use all-user search only for explicitly broad or cross-project recall.
- Search snippets, titles, and result pointers are navigation hints rather than authoritative evidence. Open a bounded source slice around the relevant message before quoting or claiming the exact decision.
- Do not load an entire conversation. Use find_in_chat to locate a term and read_chat_slice to retrieve only the surrounding sequence needed to answer.
- In the current conversation after compaction, treat the compacted summary as lossy. Use search_compacted_history for an exact older detail only when the visible summary does not resolve it.

### Use retrieved evidence
- Prefer the newest unambiguous instruction when retrieved messages conflict, and distinguish an abandoned proposal from an accepted decision or completed action.
- Never expose hidden system messages, secret-bearing tool output, or content the search service omitted as sensitive. Do not infer missing text from adjacent snippets.
- Cite or paraphrase only the relevant recovered fact, then return to the current task. Do not flood the active context with unrelated history or repeatedly search for the same already-recovered detail.`,
  },
  {
    id: 'system:opfield-inference',
    name: 'Opfield Inference',
    description: 'Configure Opfield Inference providers, models, limits, tokens, and compatible client endpoints.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Opfield Inference

### Identify the surface and prerequisites
- Opfield Inference is separate from AI Workspace provider configuration and Opfield MCP. It is a standalone external model gateway with dedicated provider connections, models, accounting, limits, continuation state, and opfi_ runtime tokens; never reuse Workspace, MCP, opf_, or opfo_ credentials on its data plane.
- Before configuring providers, models, limits, tokens, or client harnesses, activate the Inference tool category and read internal_documentation({ topic: "inference" }) for the current schemas and lifecycle.
- Read Opfield settings before client setup. Confirm generalSettings.features.inferenceEnabled; without read permission, tell the user an administrator must confirm it rather than guessing.
- Users need feat:ai:use for inference, personal usage, and creating or revoking their own runtime tokens. Never attempt to issue a token for another user.

### Administrator workflow
- Configure in this order: enable the feature, connect and synchronize a provider, publish a logical model with access/capabilities/limits, configure default or per-user limits, then test with an intended user.
- Provider connections are individual accounts or API keys. Use provider IDs returned by list operations, respect explicit subscription-terms acknowledgement, wait for interactive authorization where required, synchronize, and verify model/quota/health metadata.
- A logical model maps one provider template and one upstream model across compatible connections. Configure its context/input/output and auto-compaction limits, modalities, capabilities, reasoning map, sources, pricing, and access as one complete model configuration.
- Treat API and subscription limits separately. A zero monthly API budget disables API-funded usage and hides API-only models for that user; do not describe such models as merely selectable but temporarily failing.

### Recommended harness setup
- Recommend DeepSeek harness (https://www.deepseek.com/en/harness/), configured natively with Opfield as its OpenAI- or Anthropic-compatible provider; any other harness that accepts such a provider is set up the same way.
- In the UI: Settings > Inference > Endpoint > Set up opens Set Up an Inference Harness. It shows the OpenAI-compatible base URL (https://<opfield-host>/api/inference/v1), the Anthropic-compatible base URL (https://<opfield-host>/api/inference), a new opfi_ key it creates for the current user and shows once (unused keys from earlier openings are revoked), and the models the user can call. The user pastes these into the harness's provider settings.
- Without the UI, create the key with the current-user token tool and give the same values.

### Manual clients and verification
- OpenAI-compatible SDKs and clients use https://<opfield-host>/api/inference/v1 with a dedicated opfi_ token. The base adapter exposes the supported Models, Responses, and Chat Completions surfaces while inference is enabled.
- All inference clients use the single stable prefix https://<opfield-host>/api/inference/v1; the Anthropic SDK baseURL is https://<opfield-host>/api/inference because the SDK appends /v1 itself. Do not guess other harness endpoints—read current documentation.
- A opfi_ secret is shown once. Direct the user to Profile > Authorizations > Inference API tokens or the dedicated current-user token tool, and never repeat or store the secret in assistant history.
- After setup, verify model discovery and one small request. For administration changes also verify provider sync/health, user-visible model access, accounting, reasoning mapping, tools/continuation, and Codex compaction where applicable.
- Provider credentials remain encrypted and read tools expose only masked metadata. Activity records usage metadata rather than prompts or model output.`,
  },
  {
    id: 'system:sandbox-and-artifacts',
    name: 'Sandbox and artifacts',
    description: 'Run bounded sandbox work and handle generated files and tool-output artifacts correctly.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Sandbox and artifacts

### Choose the right operation
- Use the sandbox for bounded code, transformation, rendering, validation, or artifact production that does not belong to a managed Opfield node/container. Do not use it to bypass Opfield tools or execute against infrastructure.
- Sandbox containers have no network access. Fetch remote inputs with the supported fetch/download artifact path first; never add credentials or weaken isolation to make network access work.
- Inspect an existing workspace with list_artifact_files and read_artifact. Do not start a process merely to run ls, find, cat, or another read operation already covered by artifact tools.

### Produce and inspect files
- Deliverable files must be written under /workspace. Artifact tool paths are relative to /workspace; normalize and verify the exact file before sending it.
- Keep generated work inside the task workspace and preserve user-provided files unless the requested transformation replaces a named output. Do not write secrets into deliverables or process arguments.
- run_process returns after process startup, not necessarily completion. Use wait, inspect process output, and verify expected files or rendered results before claiming success.
- When outputOffloaded is true, do not repeat the producing command. Search or read the stored output in bounded ranges and retrieve only the relevant evidence.
- For visual/document artifacts, inspect the rendered result rather than relying only on a successful command. For code/data artifacts, run the strongest relevant bounded validation.

### Deliver
- Confirm the final file name, type, and readiness, then call send_artifact once. After it succeeds, the UI attaches the file card automatically; do not add a guessed/manual download URL or redundant file table.
- If production fails, retain useful diagnostics and state the precise missing output or verification instead of sending a partial file as complete.`,
  },
  {
    id: 'system:evidence-and-review',
    name: 'Evidence and review',
    description: 'Diagnose, review, and report from concrete current evidence without fabricating unavailable state.',
    source: 'system',
    enabled: true,
    createdAt: null,
    updatedAt: null,
    instructions: `## Evidence and review

### Investigate
- For review, audit, debugging, security analysis, or readiness assessment, establish the exact requested scope and inspect current evidence: relevant tool output, configuration, code, logs, audit events, resource state, tests, and exact errors.
- Follow the real data/control path across involved components instead of judging an isolated file or successful probe. For intermittent behavior, correlate a failing event with upstream/downstream evidence and timestamps.
- Empty or partial results may reflect scopes, filters, stale identifiers, retention, or genuinely absent state. Check the applicable boundary once; do not retry storms or fabricate inaccessible data.

### Report findings
- For review and diagnosis, lead with concrete findings ordered by impact. For each material finding, identify the affected surface, evidence, consequence, and smallest appropriate correction or verification.
- Distinguish confirmed defects from hypotheses, stale observations, permission limits, expected behavior, and missing evidence. Do not inflate severity or present a theoretical edge case as an observed regression.
- If no material issue is found, say so and name the most important verification limitation. Avoid burying the conclusion under a narration of every file or tool inspected.

### Fix and verify when authorized
- Review, audit and code diagnosis alone are read-only. Modify code or configuration only when the user asks for a fix or the request clearly includes implementation.
- A report that a running service is broken is a request to restore it: after diagnosis, carry out the reversible recovery steps the evidence supports (restart, reload, rerun a failed build or job) and verify, as the base rules say. Ask before irreversible or data-losing steps.
- Keep changes minimal and consistent with existing product patterns, contracts, and neighboring code. Do not broaden into adjacent refactors, custom UI patterns, or speculative hardening.
- Verify the changed behavior with targeted tests/builds and the real integration boundary when one is materially affected. Re-check the original failure path; a compilation success alone does not prove a runtime bug is fixed.
- If verification cannot be completed, state the exact remaining check and do not claim readiness or resolution. Preserve unrelated user changes and report any overlap that prevented safe completion.`,
  },
];

function normalizeText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new AppError(400, 'AI_SKILL_INVALID', `${field} is required`);
  if (normalized.length > maxLength)
    throw new AppError(400, 'AI_SKILL_INVALID', `${field} must be ${maxLength} characters or fewer`);
  return normalized;
}

function normalizeStoredUserSkill(value: AIUserSkillRecord): AIUserSkillRecord | null {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  const instructions = typeof value.instructions === 'string' ? value.instructions.trim() : '';
  if (!id || !name || !description || !instructions) return null;
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString();
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : createdAt;
  return { id, name, description, instructions, enabled: value.enabled !== false, createdAt, updatedAt };
}

function toAgentSkill(skill: AIUserSkillRecord): AIAgentSkill {
  return { ...skill, source: 'user' };
}

// legacy-name: system skill ids from before the Opfield rename — remove once no stored conversation loads a skill by its old id
const LEGACY_SYSTEM_SKILL_IDS: Readonly<Record<string, string>> = {
  [`system:${LEGACY_INFERENCE_FEATURE}`]: 'system:opfield-inference',
  [`${LEGACY_SKILL_PREFIX}administration-and-lifecycle`]: 'system:opfield-administration-and-lifecycle',
};

export class AISkillService {
  constructor(private readonly settings: AISettingsService) {}

  listSystemSkills(): AIAgentSkill[] {
    return SYSTEM_SKILLS.map((skill) => ({ ...skill }));
  }

  async listUserSkills(): Promise<AIUserSkillRecord[]> {
    return (await this.settings.getUserSkills())
      .map(normalizeStoredUserSkill)
      .filter((skill): skill is AIUserSkillRecord => skill !== null);
  }

  async listAllForSettings(): Promise<AIAgentSkill[]> {
    const users = (await this.listUserSkills()).map(toAgentSkill);
    return [...this.listSystemSkills(), ...users];
  }

  async listRuntimeSkills(): Promise<AIAgentSkill[]> {
    return (await this.listAllForSettings()).filter((skill) => skill.source === 'system' || skill.enabled);
  }

  async getRuntimeSkill(id: string): Promise<AIAgentSkill> {
    const wanted = LEGACY_SYSTEM_SKILL_IDS[id] ?? id;
    const skill = (await this.listRuntimeSkills()).find((candidate) => candidate.id === wanted);
    if (!skill) throw new AppError(404, 'AI_SKILL_NOT_FOUND', 'Skill not found or disabled');
    return skill;
  }

  async create(input: AIUserSkillInput): Promise<AIAgentSkill> {
    const now = new Date().toISOString();
    const skill: AIUserSkillRecord = {
      id: randomUUID(),
      name: normalizeText(input.name, 'Name', 120),
      description: normalizeText(input.description, 'Description', 500),
      instructions: normalizeText(input.instructions, 'Instructions', 20_000),
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    const skills = await this.listUserSkills();
    await this.settings.setUserSkills([...skills, skill]);
    return toAgentSkill(skill);
  }

  async update(id: string, input: Partial<AIUserSkillInput>): Promise<AIAgentSkill> {
    if (id.startsWith('system:'))
      throw new AppError(400, 'AI_SYSTEM_SKILL_IMMUTABLE', 'System skills cannot be changed');
    const skills = await this.listUserSkills();
    const index = skills.findIndex((skill) => skill.id === id);
    if (index < 0) throw new AppError(404, 'AI_SKILL_NOT_FOUND', 'Skill not found');
    const current = skills[index]!;
    const next: AIUserSkillRecord = {
      ...current,
      ...(input.name !== undefined ? { name: normalizeText(input.name, 'Name', 120) } : {}),
      ...(input.description !== undefined ? { description: normalizeText(input.description, 'Description', 500) } : {}),
      ...(input.instructions !== undefined
        ? { instructions: normalizeText(input.instructions, 'Instructions', 20_000) }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date().toISOString(),
    };
    skills[index] = next;
    await this.settings.setUserSkills(skills);
    return toAgentSkill(next);
  }

  async delete(id: string): Promise<AIAgentSkill> {
    if (id.startsWith('system:'))
      throw new AppError(400, 'AI_SYSTEM_SKILL_IMMUTABLE', 'System skills cannot be deleted');
    const skills = await this.listUserSkills();
    const index = skills.findIndex((skill) => skill.id === id);
    if (index < 0) throw new AppError(404, 'AI_SKILL_NOT_FOUND', 'Skill not found');
    const [removed] = skills.splice(index, 1);
    await this.settings.setUserSkills(skills);
    return toAgentSkill(removed!);
  }
}
