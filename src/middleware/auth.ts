import type { MiddlewareFn } from "grammy";
import type { AppContext } from "../types/context.js";
import { config } from "../config.js";

function createAuthMiddleware(): MiddlewareFn<AppContext> {
  // Extract the bot's own user ID from the token (prefix before ':')
  const botUserId = Number(config.BOT_TOKEN.split(":")[0]);

  return async (ctx, next) => {
    const userId = ctx.from?.id;

    // Silently skip updates originating from the bot itself
    if (userId === botUserId) {
      return;
    }

    if (userId === undefined || !config.ALLOWED_USER_IDS.includes(userId)) {
      console.log(
        `[Auth] ${new Date().toISOString()} Unauthorized access attempt from user ${userId ?? "unknown"}`,
      );
      return; // Silent drop - do not respond
    }

    await next();
  };
}

export { createAuthMiddleware };
