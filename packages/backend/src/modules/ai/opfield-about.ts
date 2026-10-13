/**
 * What Opfield is, written once for every agent-facing surface: the MCP server instructions, the `overview`
 * documentation topic (read_opfield_documentation, opfield://docs/overview, the assistant's internal_documentation)
 * and the assistant's system prompt. The using-opfield Agent Skill carries the same text (opfield-about.test.ts).
 */

export const OPFIELD_WHAT =
  'Opfield is a self-hosted infrastructure control plane for a fleet of nodes. One Opfield enrolls the servers it is given and runs everything on them as managed resources: ingress Routes and Domains with TLS, Secure Links through relays, Docker workloads with availability across nodes, managed PostgreSQL, key-value stores, ClickHouse and S3 object storage with availability and backups, Pages, Apps, monitoring and logging, permissions, and an AI assistant with an MCP server.';

export const OPFIELD_DIFFERENCE =
  'It is not another Docker panel for one host. It is one control plane for many nodes: each node runs small daemons that Opfield enrolls, updates and watches. Traffic and private connections go through a pool of relays, so workloads and databases need no open ports. Availability uses leases and failover: when a node fails, its workloads and databases continue on another node. Releases and updates are signed and verified before they run. Every action, by a person, an API token or an agent, passes the same scoped permissions and lands in the audit log.';

export const OPFIELD_AGENT_START = [
  'Use Opfield tools, not shell access to nodes: a change made around Opfield is not permission-checked or audited, and Opfield may overwrite it.',
  'Find anything by name, domain, image or ID with `find_resource`; see what you may do, and where, with `get_my_access`.',
  'Read `read_opfield_documentation({ topic })` before a workflow: `docker` and `availability` for workloads, `proxy`, `domains` and `ssl` for ingress and TLS, `databases` and `storage` for data, `pages` for static sites, `apps` for applications, `nodes` for servers, `logging` and `notifications` for monitoring, `permissions` for access.',
] as const;

/** The full section, Markdown. */
export const OPFIELD_ABOUT_MARKDOWN = `## What Opfield is

${OPFIELD_WHAT}

- **Ingress and TLS**: Domains and Routes on nginx ingress nodes, certificates from ACME, uploads or the internal PKI, access lists, maintenance mode.
- **Secure Links**: private paths from Routes and apps to workloads, databases and storage, carried through the relays.
- **Workloads**: Docker Containers, blue/green Deployments, Compose Projects and Git builds; replicas or failover across Docker nodes.
- **Data**: managed PostgreSQL, key-value stores (Valkey, Redis protocol), ClickHouse and SeaweedFS object storage (S3), with availability, private bindings and backups; external databases and storage too.
- **Pages and Apps**: static sites and reports with shareable links; Apps group one application's resources into environments.
- **Operations**: node health, logging, alerts, webhooks, status pages, updates, users, groups, scoped permissions and the audit log.

## How it differs

${OPFIELD_DIFFERENCE}

## Where an agent starts

${OPFIELD_AGENT_START.map((line) => `- ${line}`).join('\n')}`;

/** Short form for the MCP server instructions. */
export const OPFIELD_ABOUT_INSTRUCTIONS = `${OPFIELD_WHAT} ${OPFIELD_DIFFERENCE} Read read_opfield_documentation({ topic: "overview" }) (also opfield://docs/overview) for what each area covers and where to start.`;
