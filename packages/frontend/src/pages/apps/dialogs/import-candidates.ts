// The resources Import existing offers per app family, and the dialog's words for each family.
import { databaseTypeLabel } from "@/lib/database-type";
import { workloadImageLabel } from "@/lib/workload-image-label";
import { api } from "@/services/api";
import { planIncludes } from "@/stores/license-paywall";
import type { AppMemberFamily, AppPlaceMemberInput } from "@/types";
import { COMPOSE_PROJECT_LABEL } from "../app-resources";

export const FAMILY_TEXT: Record<
  AppMemberFamily,
  { title: string; plural: string; search: string; unbound: string }
> = {
  containers: {
    title: "Import Containers",
    plural: "containers and deployments",
    search: "Search containers...",
    unbound: "No node",
  },
  compose: {
    title: "Import Compose Projects",
    plural: "Compose projects",
    search: "Search projects...",
    unbound: "No node",
  },
  databases: {
    title: "Import Databases",
    plural: "databases",
    search: "Search databases...",
    unbound: "External",
  },
  storage: {
    title: "Import Storage",
    plural: "storage",
    search: "Search storage...",
    unbound: "External",
  },
  routes: {
    title: "Import Routes",
    plural: "routes",
    search: "Search routes...",
    unbound: "No node",
  },
  pages: {
    title: "Import Pages Projects",
    plural: "Pages projects",
    search: "Search projects...",
    unbound: "No node",
  },
  certificates: {
    title: "Import SSL Certificates",
    plural: "SSL certificates",
    search: "Search certificates...",
    unbound: "No node",
  },
  logging: {
    title: "Import Logging Environments",
    plural: "logging environments",
    search: "Search environments...",
    unbound: "No node",
  },
  domains: {
    title: "Import Domains",
    plural: "domains",
    search: "Search domains...",
    unbound: "No node",
  },
};

export interface Candidate {
  key: string;
  member: AppPlaceMemberInput;
  name: string;
  /** Second line under the name (the image of a container, or the Git repository it was built from). */
  detail: string | null;
  /** Hover text of the second line. */
  detailTitle?: string;
  kind: string;
  nodeId: string | null;
  app: { id: string; name: string; environmentId: string; environmentName: string } | null;
}

export async function loadCandidates(family: AppMemberFamily): Promise<Candidate[]> {
  switch (family) {
    case "containers": {
      const rows = await api.listDockerContainerSnapshots();
      return rows
        .filter((row) => !row.labels?.[COMPOSE_PROJECT_LABEL])
        .map((row) => {
          const nodeId = row.nodeId ?? row._nodeId ?? null;
          const deployment = row.kind === "deployment";
          const image = workloadImageLabel(row);
          return {
            key: `${nodeId}:${row.id}`,
            member: deployment
              ? { type: "deployment", id: row.deploymentId ?? row.id, nodeId: nodeId ?? undefined }
              : { type: "container", id: row.name, nodeId: nodeId ?? undefined },
            name: row.name,
            detail: image.kind === "none" ? null : image.text,
            detailTitle: image.title,
            kind: deployment ? "deployment" : "container",
            nodeId,
            app: row.app ?? null,
          } satisfies Candidate;
        });
    }
    case "compose": {
      const rows = await api.listDockerComposeProjects();
      return rows.map((row) => ({
        key: row.id,
        member: { type: "compose", id: row.id, nodeId: row.nodeId },
        name: row.name,
        detail: null,
        kind: "compose project",
        nodeId: row.nodeId,
        app: row.app ?? null,
      }));
    }
    case "databases": {
      if (!planIncludes("external-database-connections")) return [];
      const rows = (await api.listDatabases({ limit: 200 })).data;
      return rows.map((row) => ({
        key: row.id,
        member: { type: "database", id: row.id },
        name: row.name,
        detail: null,
        kind: `${row.managed ? "managed " : ""}${databaseTypeLabel(row.type)}`,
        nodeId: row.managed?.nodeId ?? null,
        app: row.app ?? null,
      }));
    }
    case "storage": {
      if (!planIncludes("storage-connections")) return [];
      const rows = (await api.listObjectStorages({ limit: 200 })).data;
      return rows.map((row) => ({
        key: row.id,
        member: { type: "storage", id: row.id },
        name: row.name,
        detail: null,
        kind: row.managed ? "managed storage" : "storage",
        nodeId: row.managed?.nodeId ?? null,
        app: row.app ?? null,
      }));
    }
    case "routes": {
      const rows = (await api.listProxyHosts({ limit: 100 })).data;
      return rows
        .filter((row) => !row.isSystem)
        .map((row) => ({
          key: row.id,
          member: { type: "route", id: row.id },
          name: row.domainNames[0] ?? row.slug,
          detail: row.domainNames.length > 1 ? row.domainNames.slice(1).join(", ") : null,
          kind: `route · ${row.type}`,
          nodeId: row.nodeId ?? null,
          app: row.app ?? null,
        }));
    }
    case "pages": {
      if (!planIncludes("pages")) return [];
      const rows = (await api.listPageProjects({ limit: 100 })).data;
      return rows.map((row) => ({
        key: row.id,
        member: { type: "pages", id: row.id },
        name: row.name,
        detail: null,
        kind: "Pages project",
        nodeId: row.nodeId,
        app: row.app ?? null,
      }));
    }
    case "certificates": {
      // System certificates (the Opfield management certificate) never join an app.
      const rows = (await api.listSSLCertificates({ limit: 100 })).data;
      return rows
        .filter((row) => !row.isSystem)
        .map((row) => ({
          key: row.id,
          member: { type: "certificate", id: row.id },
          name: row.name,
          detail: row.domainNames.join(", ") || null,
          kind: `certificate · ${row.type}`,
          nodeId: null,
          app: row.app ?? null,
        }));
    }
    case "logging": {
      if (!planIncludes("structured-logging")) return [];
      const rows = await api.listLoggingEnvironments();
      return rows.map((row) => ({
        key: row.id,
        member: { type: "logging", id: row.id },
        name: row.name,
        detail: row.description || null,
        kind: "logging environment",
        nodeId: null,
        app: row.app ?? null,
      }));
    }
    case "domains": {
      // System domains (the Opfield management domain) never join an app.
      const rows = (await api.listDomains({ page: 1, limit: 1000 })).data;
      return rows
        .filter((row) => !row.isSystem)
        .map((row) => ({
          key: row.id,
          member: { type: "domain", id: row.id },
          name: row.domain,
          detail: row.description || null,
          kind: row.ingressGroupId ? "domain · ingress group" : "domain",
          nodeId: row.nginxNodeId ?? null,
          app: row.app ?? null,
        }));
    }
  }
}
