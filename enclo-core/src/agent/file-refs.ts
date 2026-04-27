import { promises as fs } from "node:fs";
import path from "node:path";
import { globToRegex } from "../tools/glob.js";

/** Maximum number of files we'll inline for a single user message. */
export const MAX_FILES_PER_MESSAGE = 5;
/** Maximum bytes per inlined file. */
export const MAX_BYTES_PER_FILE = 100 * 1024;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

/**
 * Heuristic file extensions used to disambiguate `@username` (not a file ref)
 * from `@types.ts` or `@README.md` (file refs without a slash).
 */
const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs",
  "sh", "bash", "zsh",
  "md", "markdown", "rst", "txt",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "env",
  "html", "htm", "css", "scss", "sass", "less",
  "sql", "graphql", "gql",
  "xml", "svg",
  "lock",
]);

export interface FsAdapter {
  readFile: (p: string) => Promise<Buffer>;
  stat: (p: string) => Promise<{ size: number; isFile(): boolean }>;
  readdir: (p: string) => Promise<string[]>;
}

const DEFAULT_FS: FsAdapter = {
  readFile: (p) => fs.readFile(p),
  async stat(p) {
    const s = await fs.stat(p);
    return { size: s.size, isFile: () => s.isFile() };
  },
  readdir: (p) => fs.readdir(p),
};

/**
 * Parse user input for `@<path>` tokens that look like filesystem paths.
 *
 * Heuristic: a token qualifies if it contains a `/`, OR starts with `./`,
 * `../`, `/`, or `~`, OR ends with a known file extension. This lets
 * `@README.md` and `@src/foo.ts` through while leaving `@username` and
 * `@email@example.com` alone.
 *
 * Tokens are returned in order of first appearance, deduplicated.
 */
export function extractFileRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Match @ followed by non-whitespace, but only when preceded by whitespace
  // or the start of the string — avoids matching the @ in user@host.com.
  const re = /(?:^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    // Strip trailing punctuation that's likely part of surrounding prose.
    const stripped = raw.replace(/[),.;:!?]+$/, "");
    if (!stripped) continue;
    if (!looksLikePath(stripped)) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    out.push(stripped);
  }
  return out;
}

function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  if (token.startsWith("/") || token.startsWith("~")) return true;
  if (token.includes("/")) return true;
  // Bare token like @README.md — accept when the extension is known.
  const dot = token.lastIndexOf(".");
  if (dot > 0 && dot < token.length - 1) {
    const ext = token.slice(dot + 1).toLowerCase();
    if (KNOWN_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

export interface IncludedFile {
  /** Absolute path the file was read from. */
  path: string;
  /** Path the way the user wrote it (used in the inline `<file path=…>` tag). */
  displayPath: string;
  /** UTF-8 contents (truncated nothing — files over the cap are reported as errors). */
  content: string;
  /** Raw byte size on disk. */
  bytes: number;
}

export interface ExpandResult {
  /** The user text with each successfully resolved `@ref` replaced inline. */
  expandedText: string;
  /** Files actually inlined into the message. */
  includedFiles: IncludedFile[];
  /** Friendly per-ref error strings (missing file, oversize, glob no-match, cap hit). */
  errors: string[];
}

export interface ExpandOptions {
  fs?: FsAdapter;
  maxFiles?: number;
  maxBytesPerFile?: number;
}

/**
 * Resolve every `@<path>` token in `text`. Globs (containing `*`) are
 * expanded by walking `cwd` and pruning the standard junk directories.
 * Each successfully read file is inlined into the message as
 * `<file path="…">…</file>` in place of the original token. Tokens that
 * can't be resolved are left as-is so callers writing `@username`-style
 * mentions don't lose their text.
 */
export async function expandFileRefs(
  text: string,
  cwd: string,
  options: ExpandOptions = {},
): Promise<ExpandResult> {
  const fsImpl = options.fs ?? DEFAULT_FS;
  const maxFiles = options.maxFiles ?? MAX_FILES_PER_MESSAGE;
  const maxBytes = options.maxBytesPerFile ?? MAX_BYTES_PER_FILE;

  const refs = extractFileRefs(text);
  if (refs.length === 0) {
    return { expandedText: text, includedFiles: [], errors: [] };
  }

  const errors: string[] = [];
  const includedFiles: IncludedFile[] = [];
  /** Map from the literal token (without leading `@`) → replacement string. */
  const replacements = new Map<string, string>();

  let capHit = false;
  for (const ref of refs) {
    if (includedFiles.length >= maxFiles) {
      capHit = true;
      break;
    }
    const isGlob = ref.includes("*");
    const matches: string[] = isGlob
      ? await expandGlob(ref, cwd, fsImpl)
      : [resolveRef(ref, cwd)];
    if (isGlob && matches.length === 0) {
      errors.push(`@${ref}: no files matched`);
      continue;
    }

    const renderedParts: string[] = [];
    for (const abs of matches) {
      if (includedFiles.length >= maxFiles) {
        capHit = true;
        break;
      }
      const fileResult = await readOneFile(abs, ref, maxBytes, fsImpl);
      if ("error" in fileResult) {
        errors.push(fileResult.error);
        continue;
      }
      includedFiles.push(fileResult.file);
      renderedParts.push(renderFileBlock(fileResult.file));
    }

    if (renderedParts.length > 0) {
      replacements.set(ref, renderedParts.join("\n"));
    }
  }

  if (capHit) {
    errors.push(
      `@-refs: hit max-files cap (${maxFiles}); remaining refs were not expanded.`,
    );
  }

  const expandedText = applyReplacements(text, replacements);
  return { expandedText, includedFiles, errors };
}

function resolveRef(ref: string, cwd: string): string {
  if (ref.startsWith("~")) {
    const home = process.env["HOME"] ?? "";
    return path.join(home, ref.slice(1).replace(/^[\\/]/, ""));
  }
  return path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
}

async function readOneFile(
  abs: string,
  origRef: string,
  maxBytes: number,
  fsImpl: FsAdapter,
): Promise<{ file: IncludedFile } | { error: string }> {
  let st: { size: number; isFile(): boolean };
  try {
    st = await fsImpl.stat(abs);
  } catch {
    return { error: `@${origRef}: file not found (${abs})` };
  }
  if (!st.isFile()) {
    return { error: `@${origRef}: not a regular file (${abs})` };
  }
  if (st.size > maxBytes) {
    return {
      error: `@${origRef}: too large (${st.size} bytes > ${maxBytes} cap)`,
    };
  }
  let buf: Buffer;
  try {
    buf = await fsImpl.readFile(abs);
  } catch (err) {
    return { error: `@${origRef}: read failed: ${(err as Error).message}` };
  }
  return {
    file: {
      path: abs,
      displayPath: origRef,
      content: buf.toString("utf8"),
      bytes: st.size,
    },
  };
}

function renderFileBlock(file: IncludedFile): string {
  return `<file path="${file.path}">\n${file.content}\n</file>`;
}

function applyReplacements(text: string, replacements: Map<string, string>): string {
  if (replacements.size === 0) return text;
  return text.replace(/(^|\s)@([^\s@]+)/g, (match, lead: string, raw: string) => {
    const stripped = raw.replace(/[),.;:!?]+$/, "");
    const trailing = raw.slice(stripped.length);
    const rep = replacements.get(stripped);
    if (rep === undefined) return match;
    return `${lead}${rep}${trailing}`;
  });
}

/**
 * Expand a globbed reference by walking `cwd`. Skips the usual junk dirs
 * (node_modules, .git, dist, build, etc).
 */
async function expandGlob(
  pattern: string,
  cwd: string,
  fsImpl: FsAdapter,
): Promise<string[]> {
  const root = path.isAbsolute(pattern) ? rootOfPattern(pattern) : cwd;
  const relPattern = path.isAbsolute(pattern) ? path.relative(root, pattern) : pattern;
  const re = globToRegex(relPattern);
  const matches: string[] = [];
  await walkForGlob(root, root, re, matches, fsImpl);
  matches.sort();
  return matches;
}

function rootOfPattern(pattern: string): string {
  // Strip the wildcard tail to get a search root for absolute patterns.
  const idx = pattern.search(/[*?]/);
  if (idx === -1) return path.dirname(pattern);
  const head = pattern.slice(0, idx);
  return path.dirname(head) || "/";
}

async function walkForGlob(
  dir: string,
  base: string,
  re: RegExp,
  out: string[],
  fsImpl: FsAdapter,
): Promise<void> {
  let names: string[];
  try {
    names = await fsImpl.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st: { size: number; isFile(): boolean };
    try {
      st = await fsImpl.stat(full);
    } catch {
      continue;
    }
    if (st.isFile()) {
      const rel = path.relative(base, full);
      if (re.test(rel)) out.push(full);
    } else {
      await walkForGlob(full, base, re, out, fsImpl);
    }
  }
}
