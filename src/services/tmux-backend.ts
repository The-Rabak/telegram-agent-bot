import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { stripVTControlCharacters } from "node:util";
import type { Result } from "../types/result.js";
import type {
  TerminalBackend,
  SessionDiscoverable,
  TerminalSession,
  CreateSessionOptions,
} from "../types/terminal-backend.js";
import { ok, fail } from "../types/result.js";
import { config } from "../config.js";
import { filteredEnv } from "../utils.js";

const execFileAsync = promisify(execFileCb);

const MAX_CAPTURE_BYTES = 50 * 1024; // 50 KB

function getStderr(err: unknown): string {
  if (typeof err === "object" && err !== null && "stderr" in err) {
    const stderr = (err as Record<string, unknown>).stderr;
    return typeof stderr === "string" ? stderr : "";
  }
  return "";
}

function createTmuxBackend(): TerminalBackend & SessionDiscoverable {
  async function listSessions(): Promise<Result<TerminalSession[]>> {
    try {
      const { stdout } = await execFileAsync(
        "tmux",
        [
          "list-sessions",
          "-F",
          "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}",
        ],
        { env: filteredEnv },
      );

      const sessions: TerminalSession[] = stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, attached, windows, created] = line.split("|");
          return {
            name: name ?? "",
            attached: attached === "1",
            windows: parseInt(windows ?? "0", 10),
            created: new Date(parseInt(created ?? "0", 10) * 1000),
          };
        });

      return ok(sessions);
    } catch (err: unknown) {
      // tmux returns exit code 1 when no sessions exist or server isn't running
      const stderr = getStderr(err);
      if (
        stderr.includes("no server running") ||
        stderr.includes("no sessions") ||
        stderr.includes("error connecting")
      ) {
        return ok([]);
      }
      return fail("Failed to list tmux sessions", err);
    }
  }

  async function sessionExists(name: string): Promise<boolean> {
    try {
      await execFileAsync("tmux", ["has-session", "-t", name], {
        env: filteredEnv,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function sendKeys(
    target: string,
    text: string,
  ): Promise<Result<void>> {
    try {
      // Send text literally with -l flag
      await execFileAsync(
        "tmux",
        ["send-keys", "-t", target, "-l", text],
        { env: filteredEnv },
      );

      // Wait the configured delay
      await new Promise((resolve) =>
        setTimeout(resolve, config.SEND_KEYS_DELAY_MS),
      );

      // Send Enter
      await execFileAsync(
        "tmux",
        ["send-keys", "-t", target, "Enter"],
        { env: filteredEnv },
      );

      return ok(undefined);
    } catch (err: unknown) {
      return fail("Failed to send keys to tmux", err);
    }
  }

  async function sendKeysRaw(
    target: string,
    text: string,
  ): Promise<Result<void>> {
    try {
      await execFileAsync(
        "tmux",
        ["send-keys", "-t", target, "-l", text],
        { env: filteredEnv },
      );
      return ok(undefined);
    } catch (err: unknown) {
      return fail("Failed to send keys to tmux", err);
    }
  }

  async function sendInterrupt(target: string): Promise<Result<void>> {
    try {
      await execFileAsync(
        "tmux",
        ["send-keys", "-t", target, "C-c"],
        { env: filteredEnv },
      );
      return ok(undefined);
    } catch (err: unknown) {
      return fail("Failed to send interrupt to tmux", err);
    }
  }

  async function capturePane(target: string): Promise<Result<string>> {
    try {
      const { stdout } = await execFileAsync(
        "tmux",
        ["capture-pane", "-p", "-J", "-S", "-200", "-t", target],
        { env: filteredEnv },
      );

      let cleaned = stripVTControlCharacters(stdout);

      // Cap at 50KB
      if (Buffer.byteLength(cleaned, "utf-8") > MAX_CAPTURE_BYTES) {
        const buf = Buffer.from(cleaned, "utf-8");
        cleaned = buf.subarray(buf.byteLength - MAX_CAPTURE_BYTES).toString("utf-8");
      }

      return ok(cleaned);
    } catch (err: unknown) {
      return fail("Failed to capture tmux pane", err);
    }
  }

  async function getPaneWorkingDir(target: string): Promise<Result<string>> {
    try {
      const { stdout } = await execFileAsync(
        "tmux",
        ["display-message", "-p", "-t", target, "#{pane_current_path}"],
        { env: filteredEnv },
      );

      return ok(stdout.trim());
    } catch (err: unknown) {
      return fail("Failed to get pane working directory", err);
    }
  }

  async function createSession(options: CreateSessionOptions): Promise<Result<TerminalSession>> {
    try {
      const args = ["new-session", "-d", "-s", options.id];
      if (options.cwd) args.push("-c", options.cwd);
      await execFileAsync("tmux", args, { env: filteredEnv });
      return ok({ name: options.id, attached: false, windows: 1, created: new Date() });
    } catch (err) {
      return fail("Failed to create tmux session", err);
    }
  }

  async function destroySession(id: string): Promise<Result<void>> {
    try {
      await execFileAsync("tmux", ["kill-session", "-t", id], { env: filteredEnv });
      return ok(undefined);
    } catch (err) {
      return fail("Failed to destroy tmux session", err);
    }
  }

  async function dispose(): Promise<void> {}

  return {
    type: "tmux" as const,
    listSessions,
    sessionExists,
    sendKeys,
    sendKeysRaw,
    sendInterrupt,
    capturePane,
    getPaneWorkingDir,
    createSession,
    destroySession,
    dispose,
  };
}

type TmuxBackend = ReturnType<typeof createTmuxBackend>;

export { createTmuxBackend };
export type { TmuxBackend };
