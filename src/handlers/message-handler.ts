import type { Bot } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TmuxManager } from "../services/tmux-manager.js";
import type { SessionMapper } from "../services/session-mapper.js";

export function registerMessageHandler(
  bot: Bot<AppContext>,
  tmux: TmuxManager,
  sessionMapper: SessionMapper,
): void {
  bot.on("message:text", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return; // Message not in a topic

    const mapping = sessionMapper.getByTopic(threadId);
    if (!mapping) return; // Not a mapped topic, ignore silently

    const result = await tmux.sendKeys(mapping.tmuxSession, ctx.message.text);
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
