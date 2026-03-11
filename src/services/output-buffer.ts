/**
 * Ring buffer that accumulates PTY output for polling-based capture.
 *
 * node-pty emits streaming `onData` chunks.  This buffer collects them
 * so that `getContent()` can return a snapshot equivalent to
 * `tmux capture-pane -S -200` — the last N lines, capped at a byte limit.
 */

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 50 * 1024; // 50 KB — matches MAX_CAPTURE_BYTES in tmux-backend

function createOutputBuffer(
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
) {
  let lines: string[] = [];
  let totalBytes = 0;
  let pendingPartialLine = ""; // Data that hasn't been terminated by \n yet

  /**
   * Append raw PTY output to the buffer.
   *
   * Handles:
   *  - Partial lines (chunks that don't end with `\n`)
   *  - Carriage returns (`\r` without `\n`) that overwrite the current line
   *    content, as emitted by progress bars and spinners.
   */
  function push(data: string): void {
    const combined = pendingPartialLine + data;

    const parts = combined.split("\n");

    // If data didn't end with \n the last element is an incomplete line.
    pendingPartialLine = data.endsWith("\n") ? "" : (parts.pop() ?? "");

    for (const part of parts) {
      let line = part;

      // Carriage-return handling: keep only text after the last \r.
      if (line.includes("\r")) {
        const segments = line.split("\r");
        line = segments[segments.length - 1];
      }

      lines.push(line);
      totalBytes += Buffer.byteLength(line, "utf-8");
    }

    trim();
  }

  /** Drop oldest lines until both limits are satisfied. */
  function trim(): void {
    while (lines.length > maxLines || totalBytes > maxBytes) {
      const removed = lines.shift();
      if (removed !== undefined) {
        totalBytes -= Buffer.byteLength(removed, "utf-8");
      }
    }
  }

  /** Return all buffered content (including any pending partial line). */
  function getContent(): string {
    if (pendingPartialLine) {
      return [...lines, pendingPartialLine].join("\n");
    }
    return lines.join("\n");
  }

  /** Reset the buffer to its initial empty state. */
  function clear(): void {
    lines = [];
    totalBytes = 0;
    pendingPartialLine = "";
  }

  return { push, getContent, clear };
}

type OutputBuffer = ReturnType<typeof createOutputBuffer>;

export { createOutputBuffer };
export type { OutputBuffer };
