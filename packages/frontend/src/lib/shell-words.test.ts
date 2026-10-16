import { describe, expect, it } from "vitest";
import { formatShellWords, parseShellWords } from "./shell-words";

describe("shell words", () => {
  it("formats words so they parse back unchanged", () => {
    const words = ["sh", "-c", 'echo "hi there" && exit 0', "a\\b", "--flag=x"];
    const text = formatShellWords(words);
    expect(text.startsWith("sh -c ")).toBe(true);
    expect(parseShellWords(text)).toEqual(words);
  });
});
