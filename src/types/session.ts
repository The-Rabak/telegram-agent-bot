export type { TerminalSession } from "./terminal-backend.js";

interface SessionMapping {
  readonly sessionId: string;
  readonly backend: "tmux" | "node-pty";
  readonly topicId: number;
  readonly projectRoot: string;
  readonly createdAt: Date;
  readonly pid?: number;
  readonly processStartTime?: number;
}

export type { SessionMapping };
