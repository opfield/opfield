import { describe, expect, it } from "vitest";
import type { AuditLogEntry } from "@/types";
import { formatAuditExport, getAuditDescription, getAuditResourceDisplay } from "./audit-format";
import { LEGACY_INSTALL_DIR_NAME } from "../../../../backend/src/lib/legacy-compat";

const base: AuditLogEntry = {
  id: "e1",
  userId: null,
  action: "cloud.request",
  resourceType: "cloud-link",
  resourceId: "8c6f93ad-d058-4c1e-9f1a-2a9b4d1e7c00",
  resourceName: "Opfield account · owner@example.com",
  summary: "Read logs · app · last 200 lines",
  details: { type: "logs", service: "app", tail: 200, ok: true },
  ipAddress: null,
  userAgent: null,
  createdAt: "2026-10-12T10:00:00Z",
  userName: null,
  userEmail: null,
};

describe("audit resource display", () => {
  it("names the cloud link after its Opfield account, the agent ID only in the title, the description apart", () => {
    const display = getAuditResourceDisplay(base);
    expect(display.label).toBe("Opfield account · owner@example.com");
    expect(getAuditDescription(base)).toBe("Read logs · app · last 200 lines");
    expect(display.label).not.toContain(base.resourceId);
    expect(display.title).toContain(base.resourceId);
  });

  it("falls back to Opfield account when the account is not known", () => {
    expect(
      getAuditResourceDisplay({ ...base, resourceName: null, summary: "Read state" }).label
    ).toBe("Opfield account");
  });

  it("never shows a raw id in an activity feed", () => {
    const entry = {
      ...base,
      action: "docker.container.update",
      resourceType: "docker-container",
      resourceId: "8c6f93ad-d058-4c1e-9f1a-2a9b4d1e7c00",
      resourceName: null,
      summary: null,
      details: null,
    };
    const feed = getAuditResourceDisplay(entry, { feed: true });
    expect(feed.label).not.toContain(entry.resourceId);
    expect(feed.title).toContain(entry.resourceId);
    expect(getAuditResourceDisplay(entry).label).toContain(entry.resourceId);
  });

  it("names a built image instead of the internal registry in an activity feed", () => {
    const entry = {
      ...base,
      action: "docker.image.pull",
      resourceType: "docker-image",
      resourceId: "img1",
      resourceName: null,
      summary: null,
      details: { imageRef: `127.0.0.1:5443/${LEGACY_INSTALL_DIR_NAME}/builds/x@sha256:abc` },
    };
    expect(getAuditResourceDisplay(entry, { feed: true }).label).not.toContain("5443");
  });

  it("keeps Type / name for other resources", () => {
    expect(
      getAuditResourceDisplay({
        ...base,
        action: "node.update",
        resourceType: "node",
        resourceId: "n1",
        resourceName: "edge-1",
        summary: null,
        details: null,
      }).label
    ).toBe("Node / edge-1");
  });

  it("exports the cloud link's account and description", () => {
    const { content } = formatAuditExport([base], "csv");
    const [header, row] = content.split("\n");
    expect(header).toContain("Resource,Description");
    expect(row).toContain("Opfield account · owner@example.com,Read logs · app · last 200 lines");
  });
});
