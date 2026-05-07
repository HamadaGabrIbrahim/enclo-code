import { promises as fs } from "node:fs";
import path from "node:path";

const FRAME_DIR = "/tmp/agent-team/ui-frames";

/** Save a rendered frame to disk for visual review. Best-effort — never throws. */
export async function captureFrame(name: string, frame: string | undefined): Promise<void> {
  if (frame === undefined) return;
  try {
    await fs.mkdir(FRAME_DIR, { recursive: true });
    await fs.writeFile(path.join(FRAME_DIR, `${name}.txt`), frame, "utf8");
  } catch {
    // ignore — frame capture is diagnostic only
  }
}

/** Strip ANSI escape codes so assertions can compare readable text. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Yield long enough for ink to schedule effects, run the keypress handler,
 * and re-render. ink-testing-library's stdin doesn't queue — each write
 * overwrites the last buffer — so we must drain between sends.
 */
export function nextFrame(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait briefly after an initial render so useEffect has registered listeners. */
export const settle = (): Promise<void> => nextFrame(50);

/** Send each character of a string with a small delay so all keystrokes are seen. */
export async function type(stdin: { write(s: string): void }, s: string): Promise<void> {
  for (const ch of s) {
    stdin.write(ch);
    // eslint-disable-next-line no-await-in-loop
    await nextFrame(10);
  }
}

/** Send a single key (no chunking). Useful for control sequences. */
export async function press(stdin: { write(s: string): void }, key: string): Promise<void> {
  stdin.write(key);
  await nextFrame(20);
}
