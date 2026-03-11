import { stripVTControlCharacters } from "node:util";
import { platform, hostname, homedir } from "node:os";
import type {
  TerminalBackend,
  TerminalSession,
  CreateSessionOptions,
} from "../types/terminal-backend.js";
import type { Result } from "../types/result.js";
import { ok, fail } from "../types/result.js";
import { createOutputBuffer } from "./output-buffer.js";
import { createCwdTracker } from "./cwd-tracker.js";
import { createSafeEnv } from "../utils.js";
import type { Config } from "../config.js";

interface PtySession {
  pty: any; // IPty from node-pty (dynamically imported)
  info: TerminalSession;
  buffer: ReturnType<typeof createOutputBuffer>;
  cwdTracker: ReturnType<typeof createCwdTracker>;
  disposables: Array<{ dispose(): void }>;
  initialCwd: string;
  alive: boolean;
}

async function createNodePtyBackend(config: Config): Promise<TerminalBackend> {
  // Dynamic import for CJS/ESM interop — node-pty is a CJS package.
  let ptyModule: any;
  try {
    ptyModule = await import("node-pty");
  } catch {
    throw new Error(
      "node-pty is not installed. Install it with: npm install node-pty",
    );
  }
  const ptySpawn = ptyModule.spawn ?? (ptyModule as any).default?.spawn;
  if (!ptySpawn) {
    throw new Error("Failed to load node-pty spawn function");
  }

  const sessions = new Map<string, PtySession>();

  function getDefaultShell(): string {
    if (platform() === "win32") {
      return config.PTY_SHELL || process.env.COMSPEC || "powershell.exe";
    }
    return config.PTY_SHELL || process.env.SHELL || "/bin/bash";
  }

  function buildEnv(sessionId: string): Record<string, string> {
    const extraVars = config.PTY_ENV_EXTRA?.split(",") ?? [];
    const env = createSafeEnv(extraVars) as Record<string, string>;
    env.TELEGRAM_BRIDGE_SESSION = sessionId;
    // Ensure SystemRoot on Windows
    if (platform() === "win32" && !env.SystemRoot && process.env.SYSTEMROOT) {
      env.SystemRoot = process.env.SYSTEMROOT;
    }
    return env;
  }

  async function createSession(
    options: CreateSessionOptions,
  ): Promise<Result<TerminalSession>> {
    if (sessions.size >= config.MAX_PTY_SESSIONS) {
      return fail(
        `Maximum concurrent sessions (${config.MAX_PTY_SESSIONS}) reached`,
      );
    }
    if (sessions.has(options.id)) {
      return fail(`Session "${options.id}" already exists`);
    }

    try {
      const shell = options.shell || getDefaultShell();
      const cwd = options.cwd || homedir();
      const cols = options.cols || config.PTY_COLS;
      const rows = options.rows || config.PTY_ROWS;

      const ptyProcess = ptySpawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: buildEnv(options.id),
      });

      const buffer = createOutputBuffer();
      const cwdTracker = createCwdTracker(cwd);
      const disposables: Array<{ dispose(): void }> = [];

      const info: TerminalSession = {
        name: options.id,
        attached: true,
        windows: 1,
        created: new Date(),
      };

      const session: PtySession = {
        pty: ptyProcess,
        info,
        buffer,
        cwdTracker,
        disposables,
        initialCwd: cwd,
        alive: true,
      };

      // Wire up onData — accumulate output and track CWD from OSC 7
      disposables.push(
        ptyProcess.onData((data: string) => {
          buffer.push(data);
          cwdTracker.processOutput(data);
        }),
      );

      // Wire up onExit — mark session as dead
      disposables.push(
        ptyProcess.onExit(() => {
          session.alive = false;
        }),
      );

      sessions.set(options.id, session);
      return ok(info);
    } catch (err) {
      return fail("Failed to create PTY session", err);
    }
  }

  async function destroySession(id: string): Promise<Result<void>> {
    const session = sessions.get(id);
    if (!session) return fail(`Session "${id}" not found`);

    // Dispose listeners first
    for (const d of session.disposables) d.dispose();

    // Kill the process if still alive
    if (session.alive) {
      try {
        session.pty.kill();
      } catch {
        // Already dead — ignore
      }
    }

    session.buffer.clear();
    sessions.delete(id);
    return ok(undefined);
  }

  async function sessionExists(name: string): Promise<boolean> {
    const session = sessions.get(name);
    return session !== undefined && session.alive;
  }

  async function sendKeys(
    target: string,
    text: string,
  ): Promise<Result<void>> {
    const session = sessions.get(target);
    if (!session || !session.alive) {
      return fail(`Session "${target}" not found or not alive`);
    }
    try {
      session.pty.write(text + "\r");
      return ok(undefined);
    } catch (err) {
      return fail("Failed to send keys", err);
    }
  }

  async function sendKeysRaw(
    target: string,
    text: string,
  ): Promise<Result<void>> {
    const session = sessions.get(target);
    if (!session || !session.alive) {
      return fail(`Session "${target}" not found or not alive`);
    }
    try {
      session.pty.write(text);
      return ok(undefined);
    } catch (err) {
      return fail("Failed to send keys", err);
    }
  }

  async function sendInterrupt(target: string): Promise<Result<void>> {
    const session = sessions.get(target);
    if (!session || !session.alive) {
      return fail(`Session "${target}" not found or not alive`);
    }
    try {
      session.pty.write("\x03");
      return ok(undefined);
    } catch (err) {
      return fail("Failed to send interrupt", err);
    }
  }

  async function capturePane(target: string): Promise<Result<string>> {
    const session = sessions.get(target);
    if (!session) return fail(`Session "${target}" not found`);
    if (!session.alive) return fail(`Session "${target}" has exited`);

    const raw = session.buffer.getContent();
    const cleaned = stripVTControlCharacters(raw);

    // Cap at 50 KB from the tail
    const MAX_BYTES = 50 * 1024;
    let result = cleaned;
    if (Buffer.byteLength(result, "utf-8") > MAX_BYTES) {
      const buf = Buffer.from(result, "utf-8");
      result = buf.subarray(buf.byteLength - MAX_BYTES).toString("utf-8");
    }

    return ok(result);
  }

  async function getPaneWorkingDir(target: string): Promise<Result<string>> {
    const session = sessions.get(target);
    if (!session) return fail(`Session "${target}" not found`);
    try {
      const cwd = await session.cwdTracker.getCwd(session.pty.pid);
      return ok(cwd);
    } catch (err) {
      return fail("Failed to get working directory", err);
    }
  }

  async function dispose(): Promise<void> {
    for (const [id] of sessions) {
      await destroySession(id);
    }
  }

  return {
    type: "node-pty" as const,
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

export { createNodePtyBackend };
