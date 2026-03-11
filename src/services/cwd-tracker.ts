import { execFile as execFileCb } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { platform } from "node:os";

const execFileAsync = promisify(execFileCb);

/**
 * Pure function: extract CWD from OSC 7 escape sequence in terminal output.
 * Format: \x1b]7;file://hostname/path\x07  or  \x1b]7;file://hostname/path\x1b\\
 */
function parseOsc7(data: string): string | null {
  const match = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)[\x07\x1b]/);
  return match ? decodeURIComponent(match[1]) : null;
}

function createCwdTracker(initialCwd: string) {
  let lastKnownCwd = initialCwd;

  /** Called with each chunk of PTY output to scan for OSC 7. */
  function processOutput(data: string): void {
    const osc7Cwd = parseOsc7(data);
    if (osc7Cwd) {
      lastKnownCwd = osc7Cwd;
    }
  }

  /** Get the best-known CWD using available methods. */
  async function getCwd(pid: number): Promise<string> {
    // Try platform-specific methods first for freshness,
    // then fall back to last known CWD from OSC 7 or initial CWD.

    const currentPlatform = platform();

    if (currentPlatform === "linux") {
      try {
        const cwd = await readlink(`/proc/${pid}/cwd`);
        if (cwd) return cwd;
      } catch {
        // Fall through
      }
    }

    if (currentPlatform === "darwin") {
      try {
        const { stdout } = await execFileAsync("lsof", [
          "-OPln",
          "-p",
          String(pid),
        ]);
        const lines = stdout.split("\n");
        for (const line of lines) {
          if (line.includes("cwd")) {
            const match = line.match(/n(.+)/);
            if (match) return match[1];
          }
        }
      } catch {
        // Fall through
      }
    }

    // Fallback: last known from OSC 7 or initial CWD
    return lastKnownCwd;
  }

  function getLastKnownCwd(): string {
    return lastKnownCwd;
  }

  return { processOutput, getCwd, getLastKnownCwd };
}

type CwdTracker = ReturnType<typeof createCwdTracker>;

export { createCwdTracker, parseOsc7 };
export type { CwdTracker };
