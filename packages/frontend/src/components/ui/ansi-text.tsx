import type { CSSProperties, ReactNode } from "react";

type AnsiStyle = Pick<
  CSSProperties,
  "backgroundColor" | "color" | "fontStyle" | "fontWeight" | "textDecorationLine"
>;

interface TextSegment {
  style: AnsiStyle;
  text: string;
}

// The 16 ANSI colours follow the theme (index.css --color-ansi-*).
const BASIC_COLORS = [
  "var(--color-ansi-black)",
  "var(--color-ansi-red)",
  "var(--color-ansi-green)",
  "var(--color-ansi-yellow)",
  "var(--color-ansi-blue)",
  "var(--color-ansi-magenta)",
  "var(--color-ansi-cyan)",
  "var(--color-ansi-white)",
] as const;

const BRIGHT_COLORS = [
  "var(--color-ansi-bright-black)",
  "var(--color-ansi-bright-red)",
  "var(--color-ansi-bright-green)",
  "var(--color-ansi-bright-yellow)",
  "var(--color-ansi-bright-blue)",
  "var(--color-ansi-bright-magenta)",
  "var(--color-ansi-bright-cyan)",
  "var(--color-ansi-bright-white)",
] as const;

const ESC = "\u001b";

function xtermColor(index: number): string {
  if (index < 0) return BASIC_COLORS[0];
  if (index < 8) return BASIC_COLORS[index] ?? BASIC_COLORS[0];
  if (index < 16) return BRIGHT_COLORS[index - 8] ?? BRIGHT_COLORS[0];
  if (index < 232) {
    const normalized = index - 16;
    const r = Math.floor(normalized / 36);
    const g = Math.floor((normalized % 36) / 6);
    const b = normalized % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[r]}, ${steps[g]}, ${steps[b]})`;
  }

  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function cloneStyle(style: AnsiStyle): AnsiStyle {
  return {
    backgroundColor: style.backgroundColor,
    color: style.color,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    textDecorationLine: style.textDecorationLine,
  };
}

function isFinalCsiByte(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function stripUnhandledAnsi(text: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const escapeIndex = text.indexOf(`${ESC}[`, cursor);
    if (escapeIndex === -1) {
      result += text.slice(cursor);
      break;
    }

    result += text.slice(cursor, escapeIndex);
    let sequenceEnd = escapeIndex + 2;

    while (sequenceEnd < text.length && !isFinalCsiByte(text[sequenceEnd] ?? "")) {
      sequenceEnd += 1;
    }

    if (sequenceEnd >= text.length) break;
    cursor = sequenceEnd + 1;
  }

  return result;
}

function applyCode(style: AnsiStyle, codes: number[], startIndex: number): number {
  const code = codes[startIndex];
  if (code === undefined) return startIndex;

  if (code === 0) {
    delete style.backgroundColor;
    delete style.color;
    delete style.fontStyle;
    delete style.fontWeight;
    delete style.textDecorationLine;
    return startIndex;
  }

  if (code === 1) {
    style.fontWeight = 700;
    return startIndex;
  }

  if (code === 3) {
    style.fontStyle = "italic";
    return startIndex;
  }

  if (code === 4) {
    style.textDecorationLine = "underline";
    return startIndex;
  }

  if (code === 22) {
    delete style.fontWeight;
    return startIndex;
  }

  if (code === 23) {
    delete style.fontStyle;
    return startIndex;
  }

  if (code === 24) {
    delete style.textDecorationLine;
    return startIndex;
  }

  if (code >= 30 && code <= 37) {
    style.color = BASIC_COLORS[code - 30];
    return startIndex;
  }

  if (code >= 90 && code <= 97) {
    style.color = BRIGHT_COLORS[code - 90];
    return startIndex;
  }

  if (code === 39) {
    delete style.color;
    return startIndex;
  }

  if (code >= 40 && code <= 47) {
    style.backgroundColor = BASIC_COLORS[code - 40];
    return startIndex;
  }

  if (code >= 100 && code <= 107) {
    style.backgroundColor = BRIGHT_COLORS[code - 100];
    return startIndex;
  }

  if (code === 49) {
    delete style.backgroundColor;
    return startIndex;
  }

  if ((code === 38 || code === 48) && codes[startIndex + 1] === 5) {
    const paletteIndex = codes[startIndex + 2];
    if (paletteIndex !== undefined) {
      const color = xtermColor(paletteIndex);
      if (code === 38) style.color = color;
      else style.backgroundColor = color;
      return startIndex + 2;
    }
  }

  if ((code === 38 || code === 48) && codes[startIndex + 1] === 2) {
    const r = codes[startIndex + 2];
    const g = codes[startIndex + 3];
    const b = codes[startIndex + 4];
    if (r !== undefined && g !== undefined && b !== undefined) {
      const color = `rgb(${r}, ${g}, ${b})`;
      if (code === 38) style.color = color;
      else style.backgroundColor = color;
      return startIndex + 4;
    }
  }

  return startIndex;
}

function parseAnsiSegments(input: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const style: AnsiStyle = {};
  let cursor = 0;

  while (cursor < input.length) {
    const escapeIndex = input.indexOf(`${ESC}[`, cursor);
    if (escapeIndex === -1) {
      const text = stripUnhandledAnsi(input.slice(cursor));
      if (text) segments.push({ style: cloneStyle(style), text });
      break;
    }

    if (escapeIndex > cursor) {
      const text = stripUnhandledAnsi(input.slice(cursor, escapeIndex));
      if (text) segments.push({ style: cloneStyle(style), text });
    }

    let sequenceEnd = escapeIndex + 2;
    while (sequenceEnd < input.length && !isFinalCsiByte(input[sequenceEnd] ?? "")) {
      sequenceEnd += 1;
    }

    if (sequenceEnd >= input.length) break;

    const finalByte = input[sequenceEnd];
    const params = input.slice(escapeIndex + 2, sequenceEnd);

    if (finalByte === "m") {
      const codes = params
        .split(";")
        .filter(Boolean)
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => !Number.isNaN(part));

      if (codes.length === 0) {
        applyCode(style, [0], 0);
      } else {
        for (let i = 0; i < codes.length; i += 1) {
          i = applyCode(style, codes, i);
        }
      }
    }

    cursor = sequenceEnd + 1;
  }

  return segments.length > 0 ? segments : [{ style: {}, text: stripUnhandledAnsi(input) }];
}

export function AnsiText({ className, text }: { className?: string; text: string }) {
  const segments = parseAnsiSegments(text);

  return (
    <span className={className}>
      {segments.map((segment, index): ReactNode => {
        if (Object.keys(segment.style).length === 0) {
          return <span key={index}>{segment.text}</span>;
        }
        return (
          <span key={index} style={segment.style}>
            {segment.text}
          </span>
        );
      })}
    </span>
  );
}
