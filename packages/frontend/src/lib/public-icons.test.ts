import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSIONED_PUBLIC_ASSET } from "./public-asset-versioning";

const publicDir = path.resolve(import.meta.dirname, "../../public");
const version = (file: string) =>
  createHash("sha256")
    .update(readFileSync(path.join(publicDir, file)))
    .digest("hex")
    .slice(0, 10);

describe("site.webmanifest icons", () => {
  it("carry the content hash of each icon, so a changed icon gets a new URL", () => {
    const manifest = JSON.parse(readFileSync(path.join(publicDir, "site.webmanifest"), "utf8")) as {
      icons: { src: string }[];
    };
    for (const icon of manifest.icons) {
      const [file, query] = icon.src.replace(/^\//, "").split("?");
      expect(query, icon.src).toBe(`v=${version(file!)}`);
    }
  });
});

describe("HTML entry public assets", () => {
  it("get a content hash for every fixed-name file referenced from public/, including the web manifest", () => {
    for (const entry of ["index.html", "login.html"]) {
      const html = readFileSync(path.resolve(import.meta.dirname, "../..", entry), "utf8");
      const versioned = new Set(
        [...html.matchAll(VERSIONED_PUBLIC_ASSET)].map((match) => match[2])
      );
      const referenced = [
        ...html.matchAll(/(?:href|content)="\/([\w.-]+\.(?:ico|svg|png|webmanifest))"/g),
      ].map((match) => match[1]);
      expect(referenced, entry).toContain("site.webmanifest");
      for (const file of referenced) expect(versioned.has(file), `${entry}: ${file}`).toBe(true);
    }
  });
});
