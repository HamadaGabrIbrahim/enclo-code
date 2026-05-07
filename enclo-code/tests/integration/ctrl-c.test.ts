import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Integration test: the built CLI binary must exit cleanly when SIGINT
 * arrives. ink-testing-library can't simulate process-level signals
 * because the test runs inside the same Node process, so we drive a
 * real child instead.
 *
 * Skipped automatically if the dist build hasn't been produced — keeps
 * `npm test` green for fresh checkouts.
 */

const CLI_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "dist",
  "cli.js",
);

async function distBuilt(): Promise<boolean> {
  try {
    await fs.access(CLI_PATH);
    return true;
  } catch {
    return false;
  }
}

let child: ChildProcess | undefined;

afterEach(() => {
  if (child && !child.killed) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  child = undefined;
});

describe("CLI ctrl+c handling", () => {
  it("exits cleanly when SIGINT is received during the first-run flow", async (ctx) => {
    if (!(await distBuilt())) {
      ctx.skip();
      return;
    }

    // Use a throwaway XDG_CONFIG_HOME so we don't touch the user's real
    // config and so the CLI lands in the first-run state.
    const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-ctrlc-"));
    try {
      child = spawn(process.execPath, [CLI_PATH], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: cfgDir,
          // No TTY in the spawn — Ink falls back to a "dumb" renderer but
          // exitOnCtrlC still applies to the SIGINT we send.
          FORCE_COLOR: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Wait until the process is alive, then send SIGINT.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("CLI never produced output")),
          5000,
        );
        child!.stdout!.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        child!.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child!.once("exit", () => {
          clearTimeout(timer);
          resolve(); // unusual but not failure for the wait step
        });
      }).catch(() => undefined);

      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child!.once("exit", (code, signal) => resolve({ code, signal }));
      });

      child.kill("SIGINT");

      const result = await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("CLI did not exit within 5s of SIGINT")), 5000),
        ),
      ]);

      // Clean exits land as either code === 0 OR signal === 'SIGINT'
      // (Node propagates the signal as the exit reason when the process
      // doesn't override it). Either is acceptable — what we are guarding
      // against is "hung after ctrl+c" or "crashed with a non-zero, non-
      // SIGINT exit status".
      const cleanExit =
        result.code === 0 ||
        result.signal === "SIGINT" ||
        result.code === 130; // POSIX convention for SIGINT
      expect(cleanExit).toBe(true);
    } finally {
      await fs.rm(cfgDir, { recursive: true, force: true });
    }
  }, 15000);
});
