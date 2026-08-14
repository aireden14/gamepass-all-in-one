import { Router } from "express";
import { prisma } from "../utils/prisma";
import { validateTelegramInitData } from "../utils/telegram";
import { signToken } from "../utils/jwt";
import { safeJson } from "../utils/json";

export const authRouter = Router();

authRouter.post("/telegram", async (req, res) => {
  try {
    const { initData, fakeUser } = req.body || {};
    const botToken = process.env.BOT_TOKEN || "";
    const allowFake = process.env.DEV_ALLOW_FAKE_AUTH === "1";

    let tgUser: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
    } | null = null;

    if (initData && botToken) {
      const r = validateTelegramInitData(initData, botToken);
      if (!r.ok) {
        if (!allowFake) return res.status(401).json({ error: `bad initData: ${r.reason}` });
      } else {
        tgUser = r.user;
      }
    }

    if (!tgUser) {
      if (!allowFake) return res.status(401).json({ error: "no valid auth" });
      // fakeUser может быть null/undefined — генерируем стабильный fake id
      const fid = Number(fakeUser?.id) || 12345; // Фиксированный ID для локального теста
      tgUser = {
        id: fid,
        first_name: fakeUser?.first_name || `Тестовый игрок`,
        last_name: fakeUser?.last_name,
        username: fakeUser?.username || `test_user`,
        photo_url: undefined,
      };
    }

    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(tgUser.id) },
      update: {
        firstName: tgUser.first_name,
        lastName: tgUser.last_name ?? null,
        username: tgUser.username ?? null,
        photoUrl: tgUser.photo_url ?? null,
      },
      create: {
        telegramId: BigInt(tgUser.id),
        firstName: tgUser.first_name,
        lastName: tgUser.last_name ?? null,
        username: tgUser.username ?? null,
        photoUrl: tgUser.photo_url ?? null,
      },
    });

    const token = signToken({
      userId: user.id,
      telegramId: user.telegramId.toString(),
    });

    return res.json({ 
      token, 
      user: safeJson(user),
      botUsername: process.env.BOT_USERNAME || ""
    });
  } catch (e: any) {
    console.error("[auth/telegram]", e);
    return res.status(500).json({ error: e?.message || "server error" });
  }
});
