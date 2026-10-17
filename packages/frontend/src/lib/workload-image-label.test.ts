import { describe, expect, it } from "vitest";
import {
  deploymentImageOrigin,
  formatWorkloadSource,
  isInternalRegistryImage,
  shortCommitSha,
  workloadImageLabel,
} from "./workload-image-label";
import { LEGACY_INSTALL_DIR_NAME } from "../../../backend/src/lib/legacy-compat";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BUILT = `127.0.0.1:5443/${LEGACY_INSTALL_DIR_NAME}/builds/3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f@${DIGEST}`;
const SOURCE = {
  repositoryFullPath: "acme/shop-api",
  branch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
};

describe("workloadImageLabel", () => {
  it("names the Git source of an image built in the internal registry, like the container page", () => {
    const label = workloadImageLabel({ image: BUILT, source: SOURCE });
    expect(label).toMatchObject({ kind: "source", text: "acme/shop-api · 0123456789" });
    expect(label.title).toContain("branch main");
    expect(label.title).toContain(SOURCE.commitSha);
    expect(label.text).not.toContain("5443");
  });

  it("shows the repository alone when the commit is unknown", () => {
    expect(formatWorkloadSource({ repositoryFullPath: "acme/shop-api" })).toBe("acme/shop-api");
  });

  it("never shows the internal registry when the source is unknown", () => {
    const label = workloadImageLabel({ image: BUILT });
    expect(label.kind).toBe("internal");
    expect(label.text).toBe("Built image");
  });

  it("shows the image an internal copy was taken from", () => {
    const label = workloadImageLabel({
      image: `127.0.0.1:5443/${LEGACY_INSTALL_DIR_NAME}/promotion/0011223344556677/1700000000:image`,
      sourceImage: "ghcr.io/acme/web:1.4.2",
    });
    expect(label).toMatchObject({ kind: "image", text: "acme/web:1.4.2" });
  });

  it("shows a user-named image without its registry host", () => {
    expect(workloadImageLabel({ image: "ghcr.io/acme/web:1.4.2" }).text).toBe("acme/web:1.4.2");
    expect(workloadImageLabel({ image: "nginx:1.27", source: SOURCE }).text).toBe("nginx:1.27");
  });

  it("reads Awaiting build before the first build and a dash without an image", () => {
    expect(workloadImageLabel({ pendingSourceBuild: true, source: SOURCE }).text).toBe(
      "Awaiting build"
    );
    expect(workloadImageLabel({ image: "" })).toMatchObject({ kind: "none", text: "—" });
  });

  it("names the source of a Git container that has no image yet", () => {
    expect(workloadImageLabel({ image: "", source: SOURCE }).kind).toBe("source");
  });
});

describe("internal registry images", () => {
  it("recognises the internal registry host and Opfield repositories", () => {
    expect(isInternalRegistryImage(BUILT)).toBe(true);
    expect(isInternalRegistryImage(`${LEGACY_INSTALL_DIR_NAME}/availability/policy:mirror`)).toBe(true);
    expect(isInternalRegistryImage(`registry.example.com/${LEGACY_INSTALL_DIR_NAME}/builds:1`)).toBe(false);
    expect(isInternalRegistryImage("nginx:1.27")).toBe(false);
  });

  it("shortens commits to ten characters everywhere", () => {
    expect(shortCommitSha(SOURCE.commitSha)).toBe("0123456789");
    expect(shortCommitSha(null)).toBe("");
  });

  it("looks up a deployment image's origin", () => {
    const deployment = { imageOrigins: { [BUILT]: { source: SOURCE, sourceImage: null } } };
    expect(deploymentImageOrigin(deployment, ` ${BUILT} `).source).toBe(SOURCE);
    expect(deploymentImageOrigin(deployment, "nginx:1.27")).toEqual({
      source: null,
      sourceImage: null,
    });
  });
});
