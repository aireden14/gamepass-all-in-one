import { dateKeyInTimezone, hourInTimezone } from "../training/model";
import { prisma } from "../utils/prisma";
import { sendTelegramMessage } from "./telegramBot";

const TIMEZONE = "Asia/Nicosia";
const START_HOUR = 12;
let checking = false;

async function checkBurpiReminder() {
  if (checking) return;
  checking = true;
  try {
    const user = await prisma.user.findFirst({ where: { username: "denrech", isBot: false } });
    if (!user) return;

    const now = new Date();
    const hour = hourInTimezone(TIMEZONE, now);
    if (hour < START_HOUR) return;
    const dateKey = dateKeyInTimezone(TIMEZONE, now);
    const reminderKey = `${dateKey}:${String(hour).padStart(2, "0")}`;
    const state = await prisma.burpiReminder.findUnique({ where: { userId: user.id } });
    if (state?.completedDateKey === dateKey || state?.lastReminderKey === reminderKey) return;

    const sent = await sendTelegramMessage(
      user.telegramId.toString(),
      "BurpiOpus ждёт тренировку. Сделай хотя бы один подход и заверши день — напоминания остановятся.",
      "Открыть BurpiOpus",
      "/burpi-opus",
    );
    if (sent) {
      await prisma.burpiReminder.upsert({
        where: { userId: user.id },
        update: { lastReminderKey: reminderKey },
        create: { userId: user.id, lastReminderKey: reminderKey },
      });
    }
  } catch (error) {
    console.error("[burpi reminder]", error);
  } finally {
    checking = false;
  }
}

export function startBurpiReminderScheduler() {
  const first = setTimeout(() => void checkBurpiReminder(), 15_000);
  first.unref?.();
  const timer = setInterval(() => void checkBurpiReminder(), 60_000);
  timer.unref?.();
}
