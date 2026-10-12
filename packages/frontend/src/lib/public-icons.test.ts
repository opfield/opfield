import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
