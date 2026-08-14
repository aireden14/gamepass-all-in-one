import crypto from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 60 * 60 * 24,
): { ok: true; user: TelegramUser } | { ok: false; reason: string } {
  if (!initData) return { ok: false, reason: "empty initData" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computed !== hash) return { ok: false, reason: "bad hash" };

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) {
    return { ok: false, reason: "auth_date expired" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing user" };
  try {
    const user = JSON.parse(userRaw) as TelegramUser;
    return { ok: true, user };
  } catch {
    return { ok: false, reason: "bad user json" };
  }
}
