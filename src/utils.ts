import { lstatSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function isSymlink(filePath: string): boolean {
  try {
    const s = lstatSync(filePath);
    return s.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve a file path securely within a root directory.
 * Returns the real path if the file exists and is inside the root, null otherwise.
 * Handles symlinks and path traversal via realpath.
 */
export async function resolveSecurePath(
  filePath: string,
  projectRoot: string,
): Promise<string | null> {
  const resolved = resolve(projectRoot, filePath);
  try {
    const realRoot = await realpath(projectRoot);
    const realResolved = await realpath(resolved);
    if (!realResolved.startsWith(realRoot + sep) && realResolved !== realRoot) {
      return null;
    }
    const s = await stat(realResolved);
    if (!s.isFile()) {
      return null;
    }
    return realResolved;
  } catch {
    return null;
  }
}

/**
 * Resolve a directory path securely within a root directory.
 * Returns the real path if the directory exists and is inside the root, null otherwise.
 */
export async function resolveSecureDir(
  dirPath: string,
  projectRoot: string,
): Promise<string | null> {
  const resolved = resolve(projectRoot, dirPath);
  try {
    const realRoot = await realpath(projectRoot);
    const realResolved = await realpath(resolved);
    if (!realResolved.startsWith(realRoot + sep) && realResolved !== realRoot) {
      return null;
    }
    const s = await stat(realResolved);
    if (!s.isDirectory()) {
      return null;
    }
    return realResolved;
  } catch {
    return null;
  }
}

/** process.env with BOT_TOKEN removed, for child processes */
export const filteredEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "BOT_TOKEN"),
);
