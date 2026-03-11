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

/**
 * Allowlist of environment variables safe to pass to child processes.
 * Only these variables are forwarded; everything else (tokens, secrets,
 * API keys, database URLs, etc.) is excluded by default.
 */
const ENV_ALLOWLIST = new Set([
  // System paths
  "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  // User identity
  "USER", "USERNAME", "LOGNAME",
  // Shell
  "SHELL", "COMSPEC",
  // Terminal
  "TERM", "TERM_PROGRAM", "COLORTERM",
  // Locale
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE",
  // Editor
  "EDITOR", "VISUAL",
  // System (Windows)
  "SystemRoot", "SystemDrive", "SYSTEMROOT",
  // Temp dirs
  "TMPDIR", "TEMP", "TMP",
  // Bridge session (set by node-pty backend)
  "TELEGRAM_BRIDGE_SESSION",
  // XDG dirs (Linux)
  "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
]);

/**
 * Build a safe environment object for child processes using an allowlist.
 * Only variables in ENV_ALLOWLIST (plus any extras) are forwarded.
 *
 * @param extraVars - additional variable names to allow (e.g. from PTY_ENV_EXTRA)
 */
export function createSafeEnv(extraVars?: string[]): NodeJS.ProcessEnv {
  const allowed = new Set(ENV_ALLOWLIST);
  if (extraVars) {
    for (const v of extraVars) allowed.add(v.trim());
  }

  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => allowed.has(k)),
  );
}

/** process.env filtered to safe variables only, for child processes */
export const filteredEnv: NodeJS.ProcessEnv = createSafeEnv();
