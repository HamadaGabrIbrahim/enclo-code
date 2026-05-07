/**
 * Optional Unicode → ASCII fallback for terminals that mangle the symbols
 * we use. Activate by exporting `ENCLO_ASCII=1`. Components that render
 * glyphs should import `glyph(name)` instead of hard-coding the unicode
 * character.
 *
 * Centralizing the mapping keeps a uniform look across components even
 * when the user's terminal is hostile.
 */

const UNICODE: Record<string, string> = {
  cursor: "❯",
  arrowUp: "↑",
  arrowDown: "↓",
  bullet: "•",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  ellipsis: "…",
  separator: "─",
  zwsp: "​",
};

const ASCII: Record<string, string> = {
  cursor: ">",
  arrowUp: "^",
  arrowDown: "v",
  bullet: "*",
  check: "[x]",
  cross: "[ ]",
  warn: "!",
  ellipsis: "...",
  separator: "-",
  zwsp: "",
};

export type GlyphName = keyof typeof UNICODE;

function asciiMode(): boolean {
  return process.env["ENCLO_ASCII"] === "1";
}

export function glyph(name: GlyphName): string {
  if (asciiMode()) return ASCII[name] ?? UNICODE[name] ?? "";
  return UNICODE[name] ?? "";
}
