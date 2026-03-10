import type { Bot } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TmuxManager } from "../services/tmux-manager.js";
import type { SessionMapper } from "../services/session-mapper.js";

function registerCommands(
  bot: Bot<AppContext>,
  tmux: TmuxManager,
  sessionMapper: SessionMapper,
): void {
  bot.command("sessions", async (ctx) => {
    const result = await tmux.listSessions();

    if (!result.ok) {
      await ctx.reply("Failed to list tmux sessions.", {
        parse_mode: "HTML",
      });
      return;
    }

    const sessions = result.data;

    if (sessions.length === 0) {
      await ctx.reply("No tmux sessions found.", { parse_mode: "HTML" });
      return;
    }

    const lines: string[] = ["<b>tmux Sessions</b>", ""];

    for (const session of sessions) {
      const status = session.attached ? "attached" : "detached";
      const mapping = sessionMapper.getBySession(session.name);

      lines.push(
        `<code>${escapeHtml(session.name)}</code> - ${status}`,
      );

      if (mapping) {
        lines.push(`  \u2705 Connected (topic #${mapping.topicId})`);
      } else {
        lines.push(`  \u2B1C Not connected`);
      }

      lines.push("");
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export { registerCommands };
