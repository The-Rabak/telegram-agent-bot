import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { SessionMapping } from "../types/session.js";
import { isSymlink } from "../utils.js";

const CONFIG_DIR = join(homedir(), ".telegram-agent-bridge");
const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

const storedMappingSchema = z.object({
  tmuxSession: z.string(),
  topicId: z.number(),
  projectRoot: z.string(),
  createdAt: z.string(),
});

interface StoredMapping {
  readonly tmuxSession: string;
  readonly topicId: number;
  readonly projectRoot: string;
  readonly createdAt: string;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
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
      tmuxSession: m.tmuxSession,
      topicId: m.topicId,
      projectRoot: m.projectRoot,
      createdAt: m.createdAt.toISOString(),
    }));

    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
    chmodSync(SESSIONS_FILE, 0o600);
  }

  async function load(
    sessionExists: (name: string) => Promise<boolean>,
  ): Promise<void> {
    mappings.clear();

    const stored = readFromDisk();

    for (const entry of stored) {
      mappings.set(entry.tmuxSession, {
        tmuxSession: entry.tmuxSession,
        topicId: entry.topicId,
        projectRoot: entry.projectRoot,
        createdAt: new Date(entry.createdAt),
      });
    }

    // Reconcile: remove sessions that no longer exist in tmux
    const names = Array.from(mappings.keys());
    for (const name of names) {
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
  ): void {
    mappings.set(sessionName, {
      tmuxSession: sessionName,
      topicId,
      projectRoot,
      createdAt: new Date(),
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
