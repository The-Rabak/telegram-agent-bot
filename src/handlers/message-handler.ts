import type { Bot } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TerminalBackend } from "../types/terminal-backend.js";
import type { SessionMapper } from "../services/session-mapper.js";

export function registerMessageHandler(
  bot: Bot<AppContext>,
  backend: TerminalBackend,
  sessionMapper: SessionMapper,
): void {
  bot.on("message:text", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return; // Message not in a topic

    const mapping = sessionMapper.getByTopic(threadId);
    if (!mapping) return; // Not a mapped topic, ignore silently

    const result = await backend.sendKeys(mapping.sessionId, ctx.message.text);
    if (!result.ok) {
      await ctx.reply(`Failed to send: ${result.error.message}`);
      return;
    }

    // Try to react with checkmark, silently ignore if reactions aren't supported
    try {
      await ctx.react("\uD83D\uDC4D");
    } catch {
      // Reactions may not be supported in this bot API version
    }
  });
}
