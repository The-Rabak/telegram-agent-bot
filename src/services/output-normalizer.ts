import { stripVTControlCharacters } from "node:util";
import { escapeHtml } from "../utils.js";

// Step 1: Pre-strip patterns that Node's regex mangles
const PRE_STRIP: RegExp[] = [
  /\u001B\[\d*\s[A-Za-z]/g, // DECSCUSR (cursor shape)
  /\u001B_[\s\S]*?(?:\u0007|\u001B\\)/g, // APC sequences
  /\u001B\^[\s\S]*?(?:\u0007|\u001B\\)/g, // PM sequences
];

// Step 3: C0 control chars to strip (keep \t=0x09, \n=0x0A, \r=0x0D)
const C0_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const DEFAULT_MAX_LENGTH = 4096;
const PRE_TAG_OVERHEAD = 11; // "<pre></pre>".length

/**
 * Normalize raw terminal output through a 9-step pipeline,
 * producing clean text suitable for any messaging platform.
 */
export function normalizeTerminalOutput(raw: string): string {
  let s = raw;

  // 1. Pre-strip sequences Node misses
  for (const re of PRE_STRIP) {
    s = s.replace(re, "");
  }

  // 2. Node built-in VT stripping
  s = stripVTControlCharacters(s);

  // 3. Strip leftover C0 controls
  s = s.replace(C0_RE, "");

  // 4. Normalize line endings
  s = s.replace(/\r\n/g, "\n");

  // 5. Process carriage return overwrites (progress bars: keep text after last \r)
  s = s
    .split("\n")
    .map((line) => {
      if (line.includes("\r")) {
        const segments = line.split("\r");
        return segments[segments.length - 1];
      }
      return line;
    })
    .join("\n");

  // 6. Expand tabs to 4 spaces
  s = s.replace(/\t/g, "    ");

  // 7. Strip trailing whitespace per line
  s = s.replace(/[ ]+$/gm, "");

  // 8. Collapse 3+ consecutive blank lines to 2
  s = s.replace(/\n{4,}/g, "\n\n\n");

  // 9. Trim leading/trailing blank lines
  s = s.replace(/^\n+/, "").replace(/\n+$/, "\n");

  return s;
}

/**
 * Format normalized terminal output for Telegram:
 * escape HTML entities, truncate to fit message limits (keeping most recent
 * output), and wrap in <pre> tags for monospace rendering.
 */
export function formatForTelegram(
  normalized: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  let escaped = escapeHtml(normalized);

  const maxContent = maxLength - PRE_TAG_OVERHEAD;
  if (escaped.length > maxContent) {
    // Truncate from the front (keep most recent output)
    escaped = escaped.slice(-maxContent);
    // Clean up partial first line
    const firstNl = escaped.indexOf("\n");
    if (firstNl > 0 && firstNl < 200) {
      escaped = escaped.slice(firstNl + 1);
    }
  }

  if (!escaped.trim()) return "";
  return `<pre>${escaped}</pre>`;
}
