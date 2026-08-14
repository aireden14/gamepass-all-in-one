import { Router } from "express";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number; username?: string; first_name?: string };
  };
};

export const telegramWebhookRouter = Router();

telegramWebhookRouter.get("/status", (_req, res) => {
  res.json({
    ok: true,
    botUsername: process.env.BOT_USERNAME || "",
    webhook: true,
    t: Date.now(),
  });
});

telegramWebhookRouter.post("/webhook", (req, res) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const actualSecret = req.header("x-telegram-bot-api-secret-token");
    if (actualSecret !== expectedSecret) {
      return res.status(401).json({ ok: false, error: "bad webhook secret" });
    }
  }

  res.json({ ok: true });
  void handleTelegramUpdate(req.body as TelegramUpdate).catch((err) => {
    console.error("[telegram webhook]", err);
  });
});

async function handleTelegramUpdate(update: TelegramUpdate) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim() || "";
  if (!chatId || !text.startsWith("/start")) return;

  await sendStartMessage(chatId);
}

async function sendStartMessage(chatId: string | number) {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return;

  const botUsername = process.env.BOT_USERNAME || "Liquid_Chess_bot";
  const appUrl = `https://t.me/${botUsername}/app`;
  const frontendUrl = process.env.FRONTEND_URL || "";
  const canUseWebAppButton = /^https:\/\//i.test(frontendUrl);
  const button = canUseWebAppButton
    ? { text: "Открыть шахматы", web_app: { url: frontendUrl } }
    : { text: "Открыть шахматы", url: appUrl };

  const payload = {
    chat_id: chatId,
    text: "Шахматы живы. Открывай Mini App и заходи в партию.",
    reply_markup: { inline_keyboard: [[button]] },
  };

  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.warn("[telegram webhook] sendMessage failed", resp.status, body.slice(0, 300));
  }
}
