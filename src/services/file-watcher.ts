import { watch, readFileSync, statSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join, sep, extname } from "node:path";
import { InputFile, Bot } from "grammy";
import type { AppContext } from "../types/context.js";
import { EXCLUDED_DIRS } from "../constants.js";
import { escapeHtml, isSymlink } from "../utils.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

interface WatchEntry {
  watcher: FSWatcher;
  chatId: number;
  topicId: number;
}

function createFileWatcher(bot: Bot<AppContext>) {
  const watchers = new Map<string, WatchEntry>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  function isExcludedPath(relativePath: string): boolean {
    const segments = relativePath.split(sep);
    for (const segment of segments) {
      if (EXCLUDED_DIRS.has(segment)) {
        return true;
      }
    }
    return false;
  }

  function isMarkdownFile(filePath: string): boolean {
    return extname(filePath).toLowerCase() === ".md";
  }

  function getFileSize(filePath: string): number | null {
    try {
      const stat = statSync(filePath);
      return stat.size;
    } catch {
      return null;
    }
  }

  async function handleFileChange(
    projectRoot: string,
    relativePath: string,
    chatId: number,
    topicId: number,
  ): Promise<void> {
    const absolutePath = join(projectRoot, relativePath);

    // Symlink protection
    if (isSymlink(absolutePath)) {
      return;
    }

    // Check file size
    const size = getFileSize(absolutePath);
    if (size === null) {
      // File was deleted between detect and read
      return;
    }
    if (size > MAX_FILE_SIZE) {
      return;
    }

    // Read and send
    let content: Buffer;
    try {
      content = Buffer.from(readFileSync(absolutePath));
    } catch {
      // File deleted between stat and read -- handle gracefully
      return;
    }

    try {
      await bot.api.sendDocument(
        chatId,
        new InputFile(content, relativePath.split(sep).pop() ?? "file.md"),
        {
          message_thread_id: topicId,
          caption: `File changed: <code>${escapeHtml(relativePath)}</code>`,
          parse_mode: "HTML",
        },
      );
    } catch (err: unknown) {
      console.error(
        `[FileWatcher] Failed to send document for ${relativePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  function start(projectRoot: string, chatId: number, topicId: number): void {
    // If already watching this root, stop first
    if (watchers.has(projectRoot)) {
      stop(projectRoot);
    }

    const watcher = watch(
      projectRoot,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;

        // Fast-path: only .md files
        if (!isMarkdownFile(filename)) return;

        // Fast-path: exclude directories
        if (isExcludedPath(filename)) return;

        // Debounce per-file with 1-second window
        const debounceKey = `${projectRoot}${sep}${filename}`;
        const existingTimer = debounceTimers.get(debounceKey);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          debounceTimers.delete(debounceKey);
          void handleFileChange(projectRoot, filename, chatId, topicId);
        }, 1000);

        debounceTimers.set(debounceKey, timer);
      },
    );

    watcher.on("error", (err) => {
      console.error(
        `[FileWatcher] Watcher error for ${projectRoot}:`,
        err.message,
      );
    });

    watchers.set(projectRoot, { watcher, chatId, topicId });
  }

  function stop(projectRoot: string): void {
    const entry = watchers.get(projectRoot);
    if (entry) {
      entry.watcher.close();
      watchers.delete(projectRoot);
    }

    // Clear any debounce timers for this root
    for (const [key, timer] of debounceTimers) {
      if (key.startsWith(projectRoot + sep) || key === projectRoot) {
        clearTimeout(timer);
        debounceTimers.delete(key);
      }
    }
  }

  function stopAll(): void {
    for (const [, entry] of watchers) {
      entry.watcher.close();
    }
    watchers.clear();

    for (const [, timer] of debounceTimers) {
      clearTimeout(timer);
    }
    debounceTimers.clear();
  }

  return {
    start,
    stop,
    stopAll,
  };
}

type FileWatcher = ReturnType<typeof createFileWatcher>;

export { createFileWatcher };
export type { FileWatcher };
