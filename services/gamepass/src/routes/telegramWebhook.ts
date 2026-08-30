import { Router } from "express";
import { sendTelegramMessage } from "../services/telegramBot";

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
  await sendTelegramMessage(
    chatId,
    "GamePass на связи. Открывай Mini App — игры и сегодняшняя тренировка уже внутри.",
    "Открыть GamePass",
  );
}
