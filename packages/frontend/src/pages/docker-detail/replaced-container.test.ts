import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/services/api-base";
import { isContainerGoneError, readReplacedContainer } from "./replaced-container";

const gone = (id: string) =>
  new ApiRequestError(`container inspect: Error response from daemon: No such container: ${id}`, {
    status: 404,
    code: "CONTAINER_NOT_FOUND",
  });

describe("reading a container a recreate replaced", () => {
  it("reads the replacement by the container's name, without an error", async () => {
    const read = vi.fn(async (id: string) => {
      if (id === "old") throw gone("old");
      return [`READ_BY=${id}`];
    });
    const resolveIdByName = vi.fn(async () => "new");

    await expect(readReplacedContainer("old", "web", read, resolveIdByName)).resolves.toEqual({
      containerId: "new",
      value: ["READ_BY=new"],
    });
    expect(resolveIdByName).toHaveBeenCalledWith("web");
    expect(read.mock.calls.map(([id]) => id)).toEqual(["old", "new"]);
  });

  it("keeps the error for a container that is gone by its name too", async () => {
    const error = gone("old");
    const read = vi.fn(async () => {
      throw error;
    });

    await expect(
      readReplacedContainer("old", "web", read, async () => {
        throw new ApiRequestError("Container not found", {
          status: 404,
          code: "CONTAINER_NOT_FOUND",
        });
      })
    ).rejects.toBe(error);
    // The name still resolves only to the gone ID (nothing replaced it).
    await expect(readReplacedContainer("old", "web", read, async () => "old")).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not look the container up for other errors", async () => {
    const error = new ApiRequestError("Forbidden", { status: 403, code: "FORBIDDEN" });
    const resolveIdByName = vi.fn(async () => "new");

    await expect(
      readReplacedContainer("old", "web", async () => Promise.reject(error), resolveIdByName)
    ).rejects.toBe(error);
    await expect(
      readReplacedContainer(
        "old",
        undefined,
        async () => Promise.reject(gone("old")),
        resolveIdByName
      )
    ).rejects.toThrow("No such container: old");
    expect(resolveIdByName).not.toHaveBeenCalled();
    expect(
      isContainerGoneError(new ApiRequestError("Not found", { status: 404, code: "NOT_FOUND" }))
    ).toBe(false);
  });
});
