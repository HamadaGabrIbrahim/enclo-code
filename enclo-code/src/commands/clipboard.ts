import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_IMAGE_BYTES } from "./image.js";

export interface ClipboardImage {
  base64DataUrl: string;
  name: string;
  sizeBytes: number;
}

export type Platform = "darwin" | "linux" | "win32" | "other";

/**
 * Hook surface used by `tryReadClipboardImage` to invoke the platform's
 * clipboard tool. Tests inject a mock that returns canned PNG bytes
 * without ever spawning a real subprocess.
 */
export interface ClipboardEnv {
  platform: Platform;
  /** Counter used for the auto-name (clipboard-1.png, clipboard-2.png, …). */
  sequence: number;
  /**
   * Read raw image bytes from the clipboard. Returns null when the
   * clipboard does not contain an image. Tests override this to return
   * canned bytes; the default implementation shells out to the
   * platform-specific clipboard tool.
   */
  readImage?: (platform: Platform) => Promise<Buffer | null>;
  maxBytes?: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectPlatform(p: NodeJS.Platform = process.platform): Platform {
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "win32";
  return "other";
}

/**
 * Try to pull an image off the system clipboard. Returns null if the
 * clipboard does not contain an image (callers fall back to normal text
 * paste in that case). Errors invoking the platform-specific tool are
 * also reported as null — failure to find an image isn't an error.
 */
export async function tryReadClipboardImage(
  env: ClipboardEnv,
): Promise<ClipboardImage | null> {
  const reader = env.readImage ?? defaultReadImage;
  let buf: Buffer | null;
  try {
    buf = await reader(env.platform);
  } catch {
    return null;
  }
  if (!buf || buf.length === 0) return null;
  if (!isPng(buf)) return null;

  const cap = env.maxBytes ?? MAX_IMAGE_BYTES;
  if (buf.length > cap) return null;

  const base64 = buf.toString("base64");
  return {
    base64DataUrl: `data:image/png;base64,${base64}`,
    name: `clipboard-${env.sequence}.png`,
    sizeBytes: buf.length,
  };
}

function isPng(buf: Buffer): boolean {
  if (buf.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (buf[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

async function defaultReadImage(platform: Platform): Promise<Buffer | null> {
  if (platform === "darwin") return readMacClipboard();
  if (platform === "linux") return readLinuxClipboard();
  if (platform === "win32") return readWindowsClipboard();
  return null;
}

async function readMacClipboard(): Promise<Buffer | null> {
  // osascript reliably writes the clipboard image to a temp PNG; we then
  // read the file back. We avoid `pngpaste` since it isn't installed by
  // default.
  const tmp = path.join(os.tmpdir(), `enclo-clipboard-${process.pid}-${Date.now()}.png`);
  const script = `try
  set pngData to (the clipboard as «class PNGf»)
  set fh to open for access POSIX file "${tmp}" with write permission
  set eof of fh to 0
  write pngData to fh
  close access fh
on error
  try
    close access POSIX file "${tmp}"
  end try
  return "no_image"
end try
return "ok"`;
  try {
    const out = await runOsascript(script);
    if (out.trim() === "ok") {
      const buf = await fs.readFile(tmp);
      return buf;
    }
    return null;
  } catch {
    return null;
  } finally {
    void fs.unlink(tmp).catch(() => undefined);
  }
}

async function readLinuxClipboard(): Promise<Buffer | null> {
  // Try Wayland first, then X11.
  const wl = await runBin("wl-paste", ["--type", "image/png"]);
  if (wl) return wl;
  const xc = await runBin("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
  return xc;
}

async function readWindowsClipboard(): Promise<Buffer | null> {
  const tmp = path.join(os.tmpdir(), `enclo-clipboard-${process.pid}-${Date.now()}.png`);
  const ps = `Add-Type -AssemblyName System.Windows.Forms; ` +
    `if ([System.Windows.Forms.Clipboard]::ContainsImage()) { ` +
    `[System.Windows.Forms.Clipboard]::GetImage().Save('${tmp}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
    `Write-Output 'ok' ` +
    `} else { Write-Output 'no_image' }`;
  try {
    const out = await runProcess("powershell.exe", ["-NoProfile", "-Command", ps]);
    if (out.toString("utf8").trim() === "ok") return fs.readFile(tmp);
    return null;
  } catch {
    return null;
  } finally {
    void fs.unlink(tmp).catch(() => undefined);
  }
}

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(err).toString("utf8") || `osascript exited ${code}`));
    });
  });
}

async function runBin(cmd: string, args: string[]): Promise<Buffer | null> {
  try {
    const buf = await runProcess(cmd, args);
    if (buf.length === 0) return null;
    return buf;
  } catch {
    return null;
  }
}

function runProcess(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(Buffer.concat(err).toString("utf8") || `${cmd} exited ${code}`));
    });
  });
}
