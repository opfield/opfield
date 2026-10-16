export function parseShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (current) words.push(current);
  return words;
}

/** The inverse of parseShellWords: words with spaces, quotes or backslashes are double-quoted so they parse back unchanged. */
export function formatShellWords(words: readonly string[]): string {
  return words
    .map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replace(/[\\"]/g, "\\$&")}"`))
    .join(" ");
}
