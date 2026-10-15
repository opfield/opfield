import { describe, expect, it } from "vitest";
import {
  anonymousVolumeOwner,
  dockerVolumeLabel,
  isAnonymousVolumeName,
} from "./docker-volume-label";

const ANONYMOUS = "5eb8af4554ab1350c362bc91a541db8f9f2f64160579c1fefdb58b2267568473";

describe("dockerVolumeLabel", () => {
  it("names an anonymous volume by a short prefix, with its container when known", () => {
    expect(isAnonymousVolumeName(ANONYMOUS)).toBe(true);
    expect(dockerVolumeLabel(ANONYMOUS)).toEqual({
      text: "Anonymous volume 5eb8af45…",
      full: `Anonymous volume ${ANONYMOUS}`,
      title: ANONYMOUS,
      anonymous: true,
    });
    expect(dockerVolumeLabel(ANONYMOUS, "api").text).toBe("Anonymous volume 5eb8af45… · api");
  });

  it("keeps a named volume's name", () => {
    expect(dockerVolumeLabel("shop-data")).toEqual({
      text: "shop-data",
      full: "shop-data",
      title: "shop-data",
      anonymous: false,
    });
  });

  it("takes the owner only from a single user", () => {
    expect(anonymousVolumeOwner(["/api"])).toBe("api");
    expect(anonymousVolumeOwner(["api", "worker"])).toBeNull();
    expect(anonymousVolumeOwner(undefined)).toBeNull();
  });
});
