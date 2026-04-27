import path from "node:path";
import { promises as fs } from "node:fs";
import type { ContentBlock } from "@enclo/core";

/** Pending image attachment held in app state until the next message is sent. */
export interface PendingImage {
  /** Original (resolved absolute) path. */
  path: string;
  /** Inferred file name for display in chips and history. */
  name: string;
  /** data:<mime>;base64,<payload> */
  base64DataUrl: string;
  /** Decoded byte size — used for friendly display. */
  bytes: number;
  /** Resolved mime type. */
  mime: ImageMime;
}

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Per-file size cap. Server-side per-message cap is 10 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXT_TO_MIME: Record<string, ImageMime> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type AttachImageResult =
  | { ok: true; image: PendingImage }
  | { ok: false; error: string };

export interface AttachImageOptions {
  /** cwd used to resolve relative paths. */
  cwd: string;
  /**
   * Filesystem implementation. Defaults to node:fs/promises so tests can
   * inject a mock without touching disk.
   */
  fs?: { readFile: (p: string) => Promise<Buffer> };
  /** Optional override of the per-file size cap (used in tests). */
  maxBytes?: number;
}

/**
 * Resolve, validate, read, and base64-encode an image. Returns either a
 * ready-to-attach PendingImage or a friendly error string for the TUI.
 */
export async function attachImage(
  rawPath: string,
  opts: AttachImageOptions,
): Promise<AttachImageResult> {
  const target = rawPath.trim();
  if (target.length === 0) {
    return { ok: false, error: "/image: usage: /image <path>" };
  }
  const abs = path.isAbsolute(target) ? target : path.resolve(opts.cwd, target);
  const ext = path.extname(abs).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) {
    return {
      ok: false,
      error: `/image: unsupported extension '${ext || "(none)"}'. Use .png, .jpg, .jpeg, .webp, or .gif.`,
    };
  }
  const reader = opts.fs?.readFile ?? ((p: string) => fs.readFile(p));
  let buf: Buffer;
  try {
    buf = await reader(abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, error: `/image: ${e.code ?? ""} ${e.message}`.trim() };
  }
  const cap = opts.maxBytes ?? MAX_IMAGE_BYTES;
  if (buf.length > cap) {
    return {
      ok: false,
      error: `/image: too large: ${formatBytes(buf.length)} > ${formatBytes(cap)} cap`,
    };
  }
  const base64 = buf.toString("base64");
  const url = `data:${mime};base64,${base64}`;
  return {
    ok: true,
    image: {
      path: abs,
      name: path.basename(abs),
      base64DataUrl: url,
      bytes: buf.length,
      mime,
    },
  };
}

/**
 * Build the multi-modal `content` payload to send to /v1/chat/completions
 * for a user message that has both text and pending images attached.
 */
export function buildMultiModalContent(
  text: string,
  images: PendingImage[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const img of images) {
    blocks.push({
      type: "image_url",
      image_url: { url: img.base64DataUrl },
    });
  }
  return blocks;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
