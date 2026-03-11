import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { SessionMapping } from "../types/session.js";
import { isSymlink } from "../utils.js";

const CONFIG_DIR = join(homedir(), ".telegram-agent-bridge");
const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

const backendSchema = z.enum(["tmux", "node-pty"]);

/** New format: sessionId + backend + optional pid/processStartTime */
const newStoredMappingSchema = z.object({
  sessionId: z.string(),
  backend: backendSchema,
  topicId: z.number(),
  projectRoot: z.string(),
  createdAt: z.string(),
  pid: z.number().optional(),
  processStartTime: z.number().optional(),
});

/** Old format: tmuxSession (no backend field) -- migrated on read */
const oldStoredMappingSchema = z.object({
  tmuxSession: z.string(),
  topicId: z.number(),
  projectRoot: z.string(),
  createdAt: z.string(),
}).transform((old) => ({
  sessionId: old.tmuxSession,
  backend: "tmux" as const,
  topicId: old.topicId,
  projectRoot: old.projectRoot,
  createdAt: old.createdAt,
}));

/** Accepts both old and new formats, always outputs the new format */
const storedMappingSchema = z.union([newStoredMappingSchema, oldStoredMappingSchema]);

interface StoredMapping {
  readonly sessionId: string;
  readonly backend: "tmux" | "node-pty";
  readonly topicId: number;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly pid?: number;
  readonly processStartTime?: number;
}

/**
 * Check whether a process with the given PID is still alive.
 * Optionally verifies processStartTime to guard against PID reuse,
 * but for now existence-checking is sufficient.
 */
function isPidAlive(pid: number, _expectedStartTime?: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0: just check if process exists
    return true;
  } catch {
    return false;
  }
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, {
      mode: process.platform !== "win32" ? 0o700 : undefined,
      recursive: true,
    });
  }
}

function createSessionMapper() {
  const mappings = new Map<string, SessionMapping>();

  function readFromDisk(): StoredMapping[] {
    if (!existsSync(SESSIONS_FILE)) {
      return [];
    }

    try {
      const raw = readFileSync(SESSIONS_FILE, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const result = z.array(storedMappingSchema).safeParse(parsed);
      if (!result.success) {
        console.warn(
          `[SessionMapper] ${new Date().toISOString()} Invalid sessions.json, resetting:`,
          result.error.message,
        );
        return [];
      }
      return result.data;
    } catch (err: unknown) {
      console.warn(
        `[SessionMapper] ${new Date().toISOString()} Corrupted sessions.json, resetting:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  function writeToDisk(): void {
    ensureConfigDir();

    // Security: refuse to write if sessions.json is a symlink
    if (isSymlink(SESSIONS_FILE)) {
      console.error(
        `[SessionMapper] ${new Date().toISOString()} Refusing to write: sessions.json is a symlink`,
      );
      return;
    }

    const data: StoredMapping[] = Array.from(mappings.values()).map((m) => ({
      sessionId: m.sessionId,
      backend: m.backend,
      topicId: m.topicId,
      projectRoot: m.projectRoot,
      createdAt: m.createdAt.toISOString(),
      ...(m.pid !== undefined ? { pid: m.pid } : {}),
      ...(m.processStartTime !== undefined ? { processStartTime: m.processStartTime } : {}),
    }));

    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
    if (process.platform !== "win32") {
      chmodSync(SESSIONS_FILE, 0o600);
    }
  }

  async function load(
    sessionExists: (name: string) => Promise<boolean>,
  ): Promise<void> {
    mappings.clear();

    const stored = readFromDisk();

    for (const entry of stored) {
      mappings.set(entry.sessionId, {
        sessionId: entry.sessionId,
        backend: entry.backend,
        topicId: entry.topicId,
        projectRoot: entry.projectRoot,
        createdAt: new Date(entry.createdAt),
        ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
        ...(entry.processStartTime !== undefined ? { processStartTime: entry.processStartTime } : {}),
      });
    }

    // Reconcile: remove sessions that no longer exist
    const names = Array.from(mappings.keys());
    for (const name of names) {
      const entry = mappings.get(name)!;

      // node-pty sessions cannot be reattached after restart — kill orphaned
      // processes and always remove the mapping.
      if (entry.backend === "node-pty" && entry.pid) {
        const pidAlive = isPidAlive(entry.pid, entry.processStartTime);
        if (pidAlive) {
          try {
            process.kill(entry.pid, "SIGTERM");
          } catch {
            // Process already dead or permission denied
          }
        }
        // Always remove node-pty sessions on restart (they can't be reattached)
        mappings.delete(name);
        continue; // Skip the normal sessionExists check
      }

      const exists = await sessionExists(name);
      if (!exists) {
        mappings.delete(name);
      }
    }

    // Persist reconciled state
    writeToDisk();
  }

  function save(): void {
    writeToDisk();
  }

  function getByTopic(topicId: number): SessionMapping | null {
    for (const mapping of mappings.values()) {
      if (mapping.topicId === topicId) {
        return mapping;
      }
    }
    return null;
  }

  function getBySession(sessionName: string): SessionMapping | null {
    return mappings.get(sessionName) ?? null;
  }

  function add(
    sessionName: string,
    topicId: number,
    projectRoot: string,
    backend: "tmux" | "node-pty" = "tmux",
    pid?: number,
    processStartTime?: number,
  ): void {
    mappings.set(sessionName, {
      sessionId: sessionName,
      backend,
      topicId,
      projectRoot,
      createdAt: new Date(),
      ...(pid !== undefined ? { pid } : {}),
      ...(processStartTime !== undefined ? { processStartTime } : {}),
    });
    save();
  }

  function remove(sessionName: string): void {
    mappings.delete(sessionName);
    save();
  }

  function listAll(): SessionMapping[] {
    return Array.from(mappings.values());
  }

  return {
    load,
    save,
    getByTopic,
    getBySession,
    add,
    remove,
    listAll,
  };
}

type SessionMapper = ReturnType<typeof createSessionMapper>;

export { createSessionMapper };
export type { SessionMapper };
