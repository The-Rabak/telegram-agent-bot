import { Bot, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { parseMode } from "@grammyjs/parse-mode";
import { hydrateFiles } from "@grammyjs/files";
import type { AppContext } from "./types/context.js";
import { config } from "./config.js";
import { createAuthMiddleware } from "./middleware/auth.js";

export function createBot(): Bot<AppContext> {
  const bot = new Bot<AppContext>(config.BOT_TOKEN);

  // Install API transformers
  bot.api.config.use(autoRetry());
  bot.api.config.use(parseMode("HTML"));
  bot.api.config.use(hydrateFiles(bot.token));

  // Install auth middleware
  bot.use(createAuthMiddleware());

  // Error handler
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[Bot] Error handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error("[Bot] Telegram API error:", e.description);
    } else if (e instanceof HttpError) {
      console.error("[Bot] Network error:", e);
    } else {
      console.error("[Bot] Unknown error:", e);
    }
  });

  return bot;
}
