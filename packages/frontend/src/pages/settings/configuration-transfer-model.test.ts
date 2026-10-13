import { describe, expect, it } from "vitest";
import type {
  ConfigurationExportEstimate,
  ConfigurationExportProgress,
} from "@/services/api-configuration-transfer";
import {
  estimatedExportBytes,
  exportPassphraseProblem,
  exportProgressPercent,
  normalizeMoveAddress,
} from "./configuration-transfer-model";

describe("export passphrase", () => {
  it("needs 12 characters typed twice the same", () => {
    expect(exportPassphraseProblem("short", "short")).toMatch(/12 characters/);
    expect(exportPassphraseProblem("long enough pass", "long enough pasS")).toMatch(/match/);
    expect(exportPassphraseProblem("long enough pass", "long enough pass")).toBeNull();
  });
});

describe("export size", () => {
  const estimate: ConfigurationExportEstimate = {
    available: true,
    unavailableReason: null,
    opfieldVersion: "v2.12.0",
    sections: {
      database: { bytes: 100, available: true },
      files: { bytes: 50, available: true },
      registry: { bytes: 1000, available: true },
      logs: { bytes: null, available: false, reason: "Structured logging is off" },
    },
    hostSpecific: [],
  };

  it("adds the optional parts only when chosen", () => {
    expect(estimatedExportBytes(estimate, { includeRegistry: false, includeLogs: false })).toBe(
      150
    );
    expect(estimatedExportBytes(estimate, { includeRegistry: true, includeLogs: true })).toBe(1150);
  });

  it("holds the bar below 100 until the export completes", () => {
    const progress: ConfigurationExportProgress = {
      id: "x",
      state: "running",
      options: { includeRegistry: false, includeLogs: false },
      filename: "a.opfield-export",
      bytesWritten: 300,
      estimatedBytes: 150,
      currentPart: "database",
      createdAt: "",
      finishedAt: null,
      error: null,
    };
    expect(exportProgressPercent(progress)).toBe(99);
    expect(exportProgressPercent({ ...progress, bytesWritten: 75 })).toBe(50);
    expect(exportProgressPercent({ ...progress, estimatedBytes: null })).toBe(0);
    expect(exportProgressPercent({ ...progress, state: "completed" })).toBe(100);
  });
});

describe("move address", () => {
  it("adds the default gRPC port", () => {
    expect(normalizeMoveAddress(" opfield-new.example.com ")).toBe("opfield-new.example.com:9443");
    expect(normalizeMoveAddress("10.0.0.7")).toBe("10.0.0.7:9443");
    expect(normalizeMoveAddress("fd00::7")).toBe("[fd00::7]:9443");
    expect(normalizeMoveAddress("[fd00::7]")).toBe("[fd00::7]:9443");
  });

  it("keeps a given port", () => {
    expect(normalizeMoveAddress("opfield-new.example.com:443")).toBe("opfield-new.example.com:443");
    expect(normalizeMoveAddress("[fd00::7]:8443")).toBe("[fd00::7]:8443");
  });

  it("rejects URLs and bad ports", () => {
    expect(normalizeMoveAddress("https://opfield.example.com")).toBeNull();
    expect(normalizeMoveAddress("opfield.example.com:99999")).toBeNull();
    expect(normalizeMoveAddress("")).toBeNull();
    expect(normalizeMoveAddress("bad host")).toBeNull();
  });
});
