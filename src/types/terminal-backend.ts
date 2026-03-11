import type { Result } from "./result.js";

interface TerminalSession {
  readonly name: string;
  readonly attached: boolean;
  readonly windows: number;
  readonly created: Date;
}

interface CreateSessionOptions {
  readonly id: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly cols?: number;
  readonly rows?: number;
}

interface TerminalBackend {
  readonly type: "tmux" | "node-pty";
  sessionExists(name: string): Promise<boolean>;
  sendKeys(target: string, text: string): Promise<Result<void>>;
  sendKeysRaw(target: string, text: string): Promise<Result<void>>;
  sendInterrupt(target: string): Promise<Result<void>>;
  capturePane(target: string): Promise<Result<string>>;
  getPaneWorkingDir(target: string): Promise<Result<string>>;
  createSession(options: CreateSessionOptions): Promise<Result<TerminalSession>>;
  destroySession(id: string): Promise<Result<void>>;
  dispose(): Promise<void>;
}

interface SessionDiscoverable {
  listSessions(): Promise<Result<TerminalSession[]>>;
}

export type {
  TerminalSession,
  CreateSessionOptions,
  TerminalBackend,
  SessionDiscoverable,
};
