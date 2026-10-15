import { describe, expect, it } from "vitest";
import { joinDockerBuildLogChunks } from "./docker-build-log-lines";

const chunk = (sequence: number, content: string) => ({ sequence, content });
const contents = (chunks: { sequence: number; content: string }[]) =>
  joinDockerBuildLogChunks(chunks).map((line) => line.content);

describe("joinDockerBuildLogChunks", () => {
  it("joins a line that the daemon cut mid-line", () => {
    expect(contents([chunk(7, "#13 16.5"), chunk(9, "4 go: downloading x\n#13 16.6 y\n")])).toEqual(
      ["#13 16.54 go: downloading x", "#13 16.6 y"]
    );
  });

  it("orders chunks by sequence and ignores a repeated one", () => {
    expect(contents([chunk(3, "c\n"), chunk(1, "a"), chunk(2, "b\n"), chunk(2, "b\n")])).toEqual([
      "ab",
      "c",
    ]);
  });

  it("keeps the unfinished tail and completes it with the next chunk under the same key", () => {
    const before = joinDockerBuildLogChunks([chunk(1, "one\ntw")]);
    const after = joinDockerBuildLogChunks([chunk(1, "one\ntw"), chunk(2, "o\n")]);
    expect(before.map((line) => line.content)).toEqual(["one", "tw"]);
    expect(after.map((line) => line.content)).toEqual(["one", "two"]);
    expect(after.map((line) => line.key)).toEqual(before.map((line) => line.key));
  });

  it("treats CRLF as a line end and lets the last carriage-return rewrite win", () => {
    expect(contents([chunk(1, "a\r\nb 10%\rb 50%\rb 100%\r\n\nlast\r")])).toEqual([
      "a",
      "b 100%",
      "",
      "last",
    ]);
  });

  it("does not add an empty line after a final newline", () => {
    expect(contents([chunk(1, "a\n"), chunk(2, "b\n")])).toEqual(["a", "b"]);
  });
});
