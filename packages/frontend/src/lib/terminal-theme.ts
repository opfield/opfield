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
