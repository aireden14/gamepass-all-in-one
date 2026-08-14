import "dotenv/config";

const botToken = process.env.BOT_TOKEN;
const backendUrl = process.env.BACKEND_URL || process.env.BACKEND_HEALTH_URL;
const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!botToken) {
  throw new Error("BOT_TOKEN is required");
}

if (!backendUrl) {
  throw new Error("BACKEND_URL is required, for example https://your-service.onrender.com");
}

const baseUrl = backendUrl.replace(/\/api\/health$/, "").replace(/\/$/, "");
const webhookUrl = `${baseUrl}/api/telegram/webhook`;
const body: Record<string, unknown> = {
  url: webhookUrl,
  allowed_updates: ["message"],
  drop_pending_updates: false,
};

if (secretToken) {
  body.secret_token = secretToken;
}

const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const data = await resp.json();
console.log(JSON.stringify({ webhookUrl, response: data }, null, 2));

if (!resp.ok || !data.ok) {
  process.exitCode = 1;
}
