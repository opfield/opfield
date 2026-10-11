import { describe, expect, it } from "vitest";
import {
  hostOfTarget,
  initialRestoreAddress,
  nextChunkRange,
  RESTORE_CHUNK_BYTES,
  restoreAddressChanges,
  restoredLoginUrl,
  restoreWaitOutcome,
  resumeOffsetAfterFailure,
  uploadStartOffset,
} from "./setup-restore-model";

const MiB = 1024 * 1024;

describe("restore upload chunks", () => {
  it("walks the file in 32 MiB chunks and stops at its end", () => {
    const size = 70 * MiB;
    const ranges = [];
    for (let range = nextChunkRange(0, size); range; range = nextChunkRange(range.end, size)) {
      ranges.push(range);
    }
    expect(RESTORE_CHUNK_BYTES).toBe(32 * MiB);
    expect(ranges).toEqual([
      { start: 0, end: 32 * MiB },
      { start: 32 * MiB, end: 64 * MiB },
      { start: 64 * MiB, end: 70 * MiB },
    ]);
  });

  it("has nothing left once the offset reaches the size", () => {
    expect(nextChunkRange(10, 10)).toBeNull();
    expect(nextChunkRange(0, 0)).toBeNull();
  });

  it("resumes only an upload of the same file", () => {
    expect(uploadStartOffset({ fileSize: 100, serverBytes: 40, sameFile: true })).toBe(40);
    expect(uploadStartOffset({ fileSize: 100, serverBytes: 40, sameFile: false })).toBe(0);
    expect(uploadStartOffset({ fileSize: 100, serverBytes: 0, sameFile: true })).toBe(0);
    // More bytes than the file has: not this file, start over.
    expect(uploadStartOffset({ fileSize: 100, serverBytes: 140, sameFile: true })).toBe(0);
  });

  it("restarts a failed first chunk and continues later ones at the server's size", () => {
    expect(
      resumeOffsetAfterFailure({ confirmed: -1, serverBytes: 500, fileSize: 1000, chunkStart: 0 })
    ).toBe(0);
    expect(
      resumeOffsetAfterFailure({
        confirmed: 300,
        serverBytes: 450,
        fileSize: 1000,
        chunkStart: 300,
      })
    ).toBe(450);
    expect(
      resumeOffsetAfterFailure({
        confirmed: 300,
        serverBytes: null,
        fileSize: 1000,
        chunkStart: 300,
      })
    ).toBe(300);
    expect(
      resumeOffsetAfterFailure({
        confirmed: 300,
        serverBytes: 100,
        fileSize: 1000,
        chunkStart: 300,
      })
    ).toBe(300);
  });
});

describe("restore address", () => {
  const summary = {
    sourcePublicUrl: "https://opfield.example.com",
    sourceGrpcPublicTarget: "opfield.example.com:9443",
    sourceGrpcLocalIp: "10.0.0.5",
  };

  it("starts from the export's addresses and keeps its local IP only when this host has it", () => {
    expect(initialRestoreAddress(summary, ["10.0.0.5", "192.168.1.2"])).toEqual({
      publicUrl: "https://opfield.example.com",
      network: { grpcPublicTarget: "opfield.example.com:9443", grpcLocalIp: "10.0.0.5" },
    });
    expect(initialRestoreAddress(summary, ["192.168.1.2"]).network.grpcLocalIp).toBe("192.168.1.2");
    expect(
      initialRestoreAddress({ ...summary, sourceGrpcLocalIp: "[fd00::5]:9443" }, ["fd00::5"])
        .network.grpcLocalIp
    ).toBe("[fd00::5]:9443");
  });

  it("reads the host of a target", () => {
    expect(hostOfTarget("10.0.0.5:9443")).toBe("10.0.0.5");
    expect(hostOfTarget("[fd00::5]:9443")).toBe("fd00::5");
    expect(hostOfTarget("fd00::5")).toBe("fd00::5");
    expect(hostOfTarget("opfield.example.com")).toBe("opfield.example.com");
  });

  it("notices a changed public URL or gRPC target, not a trailing slash or case", () => {
    const same = restoreAddressChanges(summary, "https://Opfield.example.com/", {
      grpcPublicTarget: "OPFIELD.example.com:9443",
      grpcLocalIp: "",
    });
    expect(same).toEqual({ publicUrl: false, grpcPublicTarget: false });
    const moved = restoreAddressChanges(summary, "https://new.example.com", {
      grpcPublicTarget: "new.example.com:9443",
      grpcLocalIp: "",
    });
    expect(moved).toEqual({ publicUrl: true, grpcPublicTarget: true });
  });

  it("signs in at the restored address", () => {
    expect(restoredLoginUrl("https://new.example.com/")).toBe("https://new.example.com/login");
  });
});

describe("restore wait outcome", () => {
  it("is done once setup is complete, even when the view cannot be read", () => {
    expect(restoreWaitOutcome("complete", null)).toEqual({ kind: "done" });
  });

  it("keeps waiting while the app is down or the restore runs", () => {
    expect(restoreWaitOutcome(null, null)).toEqual({ kind: "waiting" });
    expect(
      restoreWaitOutcome("pending", {
        restore: { state: "restoring", step: "Restoring the database", updatedAt: "" },
      })
    ).toEqual({ kind: "waiting" });
  });

  it("reports a failed or rolled back restore with its error", () => {
    expect(
      restoreWaitOutcome("pending", {
        restore: { state: "rolled_back", step: "", updatedAt: "", error: "Disk full" },
      })
    ).toEqual({ kind: "failed", message: "Disk full" });
    expect(
      restoreWaitOutcome("pending", { restore: { state: "failed", step: "", updatedAt: "" } }).kind
    ).toBe("failed");
  });
});
