import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createTmuxBackend } from "./tmux-backend.js";
import type { TerminalBackend } from "../types/terminal-backend.js";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFileCb);

async function createTerminalBackend(config: Config): Promise<TerminalBackend> {
  const preference = config.TERMINAL_BACKEND;

  if (preference === "node-pty") {
    const { createNodePtyBackend } = await import("./node-pty-backend.js");
    return createNodePtyBackend(config);
  }

  if (preference === "tmux") {
    await assertTmuxAvailable();
    return createTmuxBackend();
  }

  // Auto-detect
  if (process.platform === "win32") {
    const { createNodePtyBackend } = await import("./node-pty-backend.js");
    return createNodePtyBackend(config);
  }

  // Unix: prefer tmux, fallback to node-pty
  try {
    await assertTmuxAvailable();
    return createTmuxBackend();
  } catch {
    console.log("[Main] tmux not available, falling back to node-pty backend");
    const { createNodePtyBackend } = await import("./node-pty-backend.js");
    return createNodePtyBackend(config);
  }
}

async function assertTmuxAvailable(): Promise<void> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, ["tmux"]);
  } catch {
    throw new Error("tmux is not installed or not on PATH");
  }
}

export { createTerminalBackend };
