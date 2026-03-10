import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TmuxManager } from "../services/tmux-manager.js";
import type { SessionMapper } from "../services/session-mapper.js";
import { config } from "../config.js";

const POLL_INTERVAL_MS = 10_000;

function startSessionDiscovery(
  bot: Bot<AppContext>,
  tmux: TmuxManager,
  sessionMapper: SessionMapper,
): () => void {
  const ignoredSessions = new Set<string>();

  const timer = setInterval(async () => {
    try {
      const result = await tmux.listSessions();
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
          `\u{1F50D} New tmux session detected: <code>${escapeHtml(session.name)}</code>\nConnect to Telegram?`,
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

    const exists = await tmux.sessionExists(sessionName);
    if (!exists) {
      await ctx.answerCallbackQuery({ text: "Session no longer exists" });
      return;
    }

    const topic = await bot.api.createForumTopic(config.CHAT_ID, sessionName);

    const dirResult = await tmux.getPaneWorkingDir(sessionName);
    const workingDir = dirResult.ok ? dirResult.data : "/unknown";

    sessionMapper.add(sessionName, topic.message_thread_id, workingDir);

    await bot.api.sendMessage(
      config.CHAT_ID,
      `\u2705 Connected to tmux session <code>${escapeHtml(sessionName)}</code>\nWorking directory: <code>${escapeHtml(workingDir)}</code>`,
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export { startSessionDiscovery };
