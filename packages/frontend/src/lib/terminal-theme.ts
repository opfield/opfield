import type { ITheme } from "@xterm/xterm";

// The xterm palette from the theme tokens in index.css: surface, text, cursor, selection and the
// 16 ANSI colours (--color-ansi-*), read from the document so terminals follow light and dark.

const ANSI_KEYS = [
  ["black", "black"],
  ["red", "red"],
  ["green", "green"],
  ["yellow", "yellow"],
  ["blue", "blue"],
  ["magenta", "magenta"],
  ["cyan", "cyan"],
  ["white", "white"],
  ["brightBlack", "bright-black"],
  ["brightRed", "bright-red"],
  ["brightGreen", "bright-green"],
  ["brightYellow", "bright-yellow"],
  ["brightBlue", "bright-blue"],
  ["brightMagenta", "bright-magenta"],
  ["brightCyan", "bright-cyan"],
  ["brightWhite", "bright-white"],
] as const;

export type TerminalAnsiPalette = Partial<Record<(typeof ANSI_KEYS)[number][0], string>>;

/** The ANSI colours of the current theme; a token that is missing is left to xterm's default. */
export function terminalAnsiPalette(style: CSSStyleDeclaration): TerminalAnsiPalette {
  const palette: TerminalAnsiPalette = {};
  for (const [key, token] of ANSI_KEYS) {
    const value = style.getPropertyValue(`--color-ansi-${token}`).trim();
    if (value) palette[key] = value;
  }
  return palette;
}

/**
 * The full xterm theme of the current theme: card surface and text, primary cursor, selection
 * (--color-terminal-selection*) and the ANSI colours. Missing tokens are left out, so xterm keeps
 * its own default for them.
 */
export function terminalTheme(style: CSSStyleDeclaration): ITheme {
  const read = (token: string) => style.getPropertyValue(token).trim();
  const theme: Record<string, string> = {
    background: read("--color-card"),
    foreground: read("--color-card-foreground"),
    cursor: read("--color-primary"),
    cursorAccent: read("--color-primary-foreground"),
    selectionBackground: read("--color-terminal-selection"),
    selectionInactiveBackground: read("--color-terminal-selection-inactive"),
  };
  for (const key of Object.keys(theme)) if (!theme[key]) delete theme[key];
  return { ...theme, ...terminalAnsiPalette(style) };
}
