import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TerminalBackend, SessionDiscoverable } from "../types/terminal-backend.js";
import type { SessionMapper } from "../services/session-mapper.js";
import type { OutputMonitor } from "../services/output-monitor.js";
import type { FileWatcher } from "../services/file-watcher.js";
import { config } from "../config.js";
import { escapeHtml } from "../utils.js";

const POLL_INTERVAL_MS = 10_000;

function startSessionDiscovery(
  bot: Bot<AppContext>,
  backend: TerminalBackend & SessionDiscoverable,
  sessionMapper: SessionMapper,
  outputMonitor: OutputMonitor,
  fileWatcher: FileWatcher,
): () => void {
  if (backend.type === "node-pty") return () => {};

  const ignoredSessions = new Set<string>();

  const timer = setInterval(async () => {
    try {
      const result = await backend.listSessions();
      if (!result.ok) {
        return;
      }

      for (const session of result.data) {
        const alreadyMapped = sessionMapper.getBySession(session.name) !== null;
        const alreadyIgnored = ignoredSessions.has(session.name);

        if (alreadyMapped || alreadyIgnored) {
          continue;
        }

        const keyboard = new InlineKeyboard()
          .text("Connect", `connect:${session.name}`)
          .text("Ignore", `ignore:${session.name}`);

        await bot.api.sendMessage(
          config.CHAT_ID,
          `\u{1F50D} New terminal session detected: <code>${escapeHtml(session.name)}</code>\nConnect to Telegram?`,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
          },
        );
      }
    } catch (err: unknown) {
      console.error(
        `[SessionDiscovery] ${new Date().toISOString()} Polling error:`,
        err instanceof Error ? err.message : err,
      );
    }
  }, POLL_INTERVAL_MS);

  // Register callback query handlers
  bot.callbackQuery(/^connect:(.+)$/, async (ctx) => {
    const sessionName = ctx.match[1];

    const exists = await backend.sessionExists(sessionName);
    if (!exists) {
      await ctx.answerCallbackQuery({ text: "Session no longer exists" });
      return;
    }

    const topic = await bot.api.createForumTopic(config.CHAT_ID, sessionName);

    const dirResult = await backend.getPaneWorkingDir(sessionName);
    const workingDir = dirResult.ok ? dirResult.data : "/unknown";

    sessionMapper.add(sessionName, topic.message_thread_id, workingDir);

    // Start monitoring for the newly connected session
    outputMonitor.start(sessionName);
    fileWatcher.start(workingDir, config.CHAT_ID, topic.message_thread_id);

    await bot.api.sendMessage(
      config.CHAT_ID,
      `\u2705 Connected to terminal session <code>${escapeHtml(sessionName)}</code>\nWorking directory: <code>${escapeHtml(workingDir)}</code>`,
      {
        parse_mode: "HTML",
        message_thread_id: topic.message_thread_id,
      },
    );

    await ctx.editMessageText(
      `\u2705 Connected: <code>${escapeHtml(sessionName)}</code> \u2192 topic #${topic.message_thread_id}`,
      { parse_mode: "HTML" },
    );

    await ctx.answerCallbackQuery({ text: "Connected!" });
  });

  bot.callbackQuery(/^ignore:(.+)$/, async (ctx) => {
    const sessionName = ctx.match[1];

    ignoredSessions.add(sessionName);

    await ctx.editMessageText(
      `\u274C Ignored: <code>${escapeHtml(sessionName)}</code>`,
      { parse_mode: "HTML" },
    );

    await ctx.answerCallbackQuery({ text: "Ignored" });
  });

  return () => clearInterval(timer);
}

export { startSessionDiscovery };
