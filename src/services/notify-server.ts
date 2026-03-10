import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:http";
import { z } from "zod";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep, basename } from "node:path";
import type { AppContext } from "../types/context.js";
import type { SessionMapper } from "./session-mapper.js";
import type { TmuxManager } from "./tmux-manager.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const notifySchema = z.object({
  session: z.string().min(1),
  type: z
    .enum(["info", "success", "warning", "error", "progress", "attention", "file"])
    .default("info"),
  message: z.string().min(1),
  progress: z
    .object({
      current: z.number(),
      total: z.number(),
      label: z.string(),
    })
    .optional(),
  file: z
    .object({
      path: z.string(),
      caption: z.string().optional(),
    })
    .optional(),
  actions: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
      }),
    )
    .max(4)
    .optional(),
});

type Notification = z.infer<typeof notifySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, maxBytes: number = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ts(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Debounce tracker
// ---------------------------------------------------------------------------

interface DebounceState {
  timestamps: number[];
  batchBuffer: string[];
  batchTimer: ReturnType<typeof setTimeout> | null;
}

const DEBOUNCE_WINDOW_MS = 10_000;
const DEBOUNCE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createNotifyServer(
  bot: Bot<AppContext>,
  sessionMapper: SessionMapper,
  tmux: TmuxManager,
) {
  let server: Server | null = null;

  // Track progress messages per session so we can edit them
  const progressMessages = new Map<string, number>();

  // Store action values for attention notifications keyed by "session:messageId"
  const pendingActions = new Map<string, string[]>();

  // Debounce state per session
  const debounceStates = new Map<string, DebounceState>();

  // -------------------------------------------------------------------------
  // Debounce helpers
  // -------------------------------------------------------------------------

  function getDebounceState(session: string): DebounceState {
    let state = debounceStates.get(session);
    if (!state) {
      state = { timestamps: [], batchBuffer: [], batchTimer: null };
      debounceStates.set(session, state);
    }
    return state;
  }

  function recordNotification(session: string): boolean {
    const state = getDebounceState(session);
    const now = Date.now();
    state.timestamps.push(now);
    // Remove timestamps outside the sliding window
    state.timestamps = state.timestamps.filter((t) => now - t < DEBOUNCE_WINDOW_MS);
    return state.timestamps.length >= DEBOUNCE_THRESHOLD;
  }

  async function flushBatch(session: string): Promise<void> {
    const state = debounceStates.get(session);
    if (!state || state.batchBuffer.length === 0) return;

    const mapping = sessionMapper.getBySession(session);
    if (!mapping) return;

    const combined = state.batchBuffer.join("\n---\n");
    state.batchBuffer = [];
    state.batchTimer = null;

    try {
      await bot.api.sendMessage(config.CHAT_ID, combined, {
        message_thread_id: mapping.topicId,
        parse_mode: "HTML",
      });
    } catch (err: unknown) {
      console.error(
        `[Notify] ${ts()} Failed to flush batched messages for "${session}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Format message by type
  // -------------------------------------------------------------------------

  function formatMessage(notification: Notification): string {
    const msg = escapeHtml(notification.message);
    switch (notification.type) {
      case "success":
        return `\u2705 <b>Done:</b> ${msg}`;
      case "warning":
        return `\u26A0\uFE0F <b>Warning:</b> ${msg}`;
      case "error":
        return `\u274C <b>Error:</b> ${msg}`;
      case "progress": {
        const p = notification.progress;
        if (p) {
          return `[${p.current}/${p.total}] ${escapeHtml(p.label)} - ${msg}`;
        }
        return msg;
      }
      case "info":
      case "attention":
      case "file":
      default:
        return msg;
    }
  }

  // -------------------------------------------------------------------------
  // Path traversal protection
  // -------------------------------------------------------------------------

  async function resolveSecurePath(
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

  // -------------------------------------------------------------------------
  // Handle individual notification
  // -------------------------------------------------------------------------

  async function handleNotification(notification: Notification): Promise<void> {
    const mapping = sessionMapper.getBySession(notification.session);
    if (!mapping) {
      console.warn(
        `[Notify] ${ts()} No mapping for session "${notification.session}"`,
      );
      return;
    }

    const topicId = mapping.topicId;
    const chatId = config.CHAT_ID;

    // Check debounce (skip for progress/file/attention which need special handling)
    if (
      notification.type !== "progress" &&
      notification.type !== "file" &&
      notification.type !== "attention"
    ) {
      const shouldBatch = recordNotification(notification.session);
      if (shouldBatch) {
        const state = getDebounceState(notification.session);
        state.batchBuffer.push(formatMessage(notification));
        if (!state.batchTimer) {
          state.batchTimer = setTimeout(() => {
            void flushBatch(notification.session);
          }, 2000);
        }
        return;
      }
    }

    const text = formatMessage(notification);

    switch (notification.type) {
      case "progress": {
        const existingMsgId = progressMessages.get(notification.session);
        if (existingMsgId) {
          try {
            await bot.api.editMessageText(chatId, existingMsgId, text, {
              parse_mode: "HTML",
            });
            return;
          } catch {
            progressMessages.delete(notification.session);
          }
        }
        const sent = await bot.api.sendMessage(chatId, text, {
          message_thread_id: topicId,
          parse_mode: "HTML",
        });
        progressMessages.set(notification.session, sent.message_id);
        return;
      }

      case "attention": {
        const keyboard = new InlineKeyboard();
        const actions = notification.actions ?? [];
        for (let i = 0; i < actions.length; i++) {
          keyboard.text(
            actions[i].label,
            `notify-action:${notification.session}:${i}`,
          );
        }
        const sentMsg = await bot.api.sendMessage(chatId, text, {
          message_thread_id: topicId,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        // Store action values so the callback handler can send the right value to tmux
        if (actions.length > 0) {
          pendingActions.set(
            `${notification.session}:${sentMsg.message_id}`,
            actions.map((a) => a.value),
          );
        }
        return;
      }

      case "file": {
        if (!notification.file) {
          await bot.api.sendMessage(chatId, "File notification missing file data.", {
            message_thread_id: topicId,
          });
          return;
        }

        const securePath = await resolveSecurePath(
          notification.file.path,
          mapping.projectRoot,
        );

        if (!securePath) {
          await bot.api.sendMessage(
            chatId,
            `\u274C File access denied or not found: <code>${escapeHtml(notification.file.path)}</code>`,
            { message_thread_id: topicId, parse_mode: "HTML" },
          );
          return;
        }

        const stream = createReadStream(securePath);
        const inputFile = new InputFile(stream, basename(securePath));
        await bot.api.sendDocument(chatId, inputFile, {
          message_thread_id: topicId,
          caption: notification.file.caption ?? undefined,
        });
        return;
      }

      default: {
        await bot.api.sendMessage(chatId, text, {
          message_thread_id: topicId,
          parse_mode: "HTML",
        });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Register callback handler for attention action buttons
  // -------------------------------------------------------------------------

  bot.callbackQuery(/^notify-action:(.+):(\d+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(
      /^notify-action:(.+):(\d+)$/,
    );
    if (!match) return;

    const sessionName = match[1];
    const actionIndex = parseInt(match[2], 10);

    // Retrieve stored action values for this message
    const storedActions = pendingActions.get(
      `${sessionName}:${ctx.callbackQuery.message?.message_id}`,
    );

    if (!storedActions || actionIndex >= storedActions.length) {
      await ctx.answerCallbackQuery({ text: "Action expired" });
      return;
    }

    const actionValue = storedActions[actionIndex];

    const result = await tmux.sendKeys(sessionName, actionValue);

    if (result.ok) {
      await ctx.answerCallbackQuery({ text: "Sent to session" });
    } else {
      await ctx.answerCallbackQuery({
        text: `Failed: ${result.error.message}`,
      });
    }

    // Edit message to show which action was taken and remove the keyboard
    try {
      const originalText =
        ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
          ? ctx.callbackQuery.message.text ?? ""
          : "";
      await ctx.editMessageText(
        `${originalText}\n\n<i>(action: ${escapeHtml(actionValue)})</i>`,
        { parse_mode: "HTML" },
      );
    } catch {
      // Best effort: message may have been deleted
    }

    // Clean up stored actions
    pendingActions.delete(
      `${sessionName}:${ctx.callbackQuery.message?.message_id}`,
    );
  });

  // -------------------------------------------------------------------------
  // HTTP request handler
  // -------------------------------------------------------------------------

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "";
    const url = req.url ?? "";

    // GET /health
    if (method === "GET" && url === "/health") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }

    // POST /notify
    if (method === "POST" && url === "/notify") {
      let rawBody: string;
      try {
        rawBody = await readBody(req, 1024);
      } catch (err: unknown) {
        jsonResponse(res, 413, {
          error: err instanceof Error ? err.message : "Body too large",
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      const result = notifySchema.safeParse(parsed);
      if (!result.success) {
        jsonResponse(res, 400, {
          error: "Validation failed",
          details: result.error.flatten(),
        });
        return;
      }

      const notification = result.data;
      console.log(
        `[Notify] ${ts()} session="${notification.session}" type="${notification.type}" message="${notification.message}"`,
      );

      try {
        await handleNotification(notification);
        jsonResponse(res, 200, { ok: true });
      } catch (err: unknown) {
        console.error(
          `[Notify] ${ts()} Error handling notification:`,
          err instanceof Error ? err.message : err,
        );
        jsonResponse(res, 500, {
          error: "Failed to deliver notification",
        });
      }
      return;
    }

    // Everything else -> 404
    jsonResponse(res, 404, { error: "Not found" });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function start(): void {
    server = createServer((req, res) => {
      handleRequest(req, res).catch((err: unknown) => {
        console.error(
          `[Notify] ${ts()} Unhandled error in request handler:`,
          err instanceof Error ? err.message : err,
        );
        if (!res.headersSent) {
          jsonResponse(res, 500, { error: "Internal server error" });
        }
      });
    });

    server.listen(config.NOTIFY_PORT, "127.0.0.1", () => {
      console.log(
        `[Notify] ${ts()} Listening on http://127.0.0.1:${config.NOTIFY_PORT}`,
      );
    });
  }

  function stop(): void {
    if (server) {
      server.close();
      server = null;
      console.log(`[Notify] ${ts()} Server stopped`);
    }
    // Clean up debounce timers
    for (const state of debounceStates.values()) {
      if (state.batchTimer) {
        clearTimeout(state.batchTimer);
      }
    }
    debounceStates.clear();
    progressMessages.clear();
    pendingActions.clear();
  }

  return { start, stop };
}

type NotifyServer = ReturnType<typeof createNotifyServer>;

export { createNotifyServer };
export type { NotifyServer };
