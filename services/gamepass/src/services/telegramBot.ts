type TelegramButton = {
  text: string;
  web_app?: { url: string };
  url?: string;
};

function webAppButton(text: string, path = ""): TelegramButton {
  const botUsername = process.env.BOT_USERNAME || "Liquid_Chess_bot";
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  if (/^https:\/\//i.test(frontendUrl)) {
    return { text, web_app: { url: `${frontendUrl}${path.startsWith("/") ? path : `/${path}`}` } };
  }
  return { text, url: `https://t.me/${botUsername}/app` };
}

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  buttonText: string,
  appPath = "",
): Promise<boolean> {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return false;

  const payload = {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [[webAppButton(buttonText, appPath)]] },
  };

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return true;

  const body = await response.text().catch(() => "");
  console.warn("[telegram] sendMessage failed", response.status, body.slice(0, 300));
  return false;
}

