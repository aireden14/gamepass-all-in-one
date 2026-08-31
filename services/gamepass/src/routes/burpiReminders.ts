import { Router } from "express";
import { authMiddleware, type AuthedRequest } from "../middleware/auth";
import { prisma } from "../utils/prisma";
import { dateKeyInTimezone } from "../training/model";
import { isDenrechUsername } from "../services/trainingProfile";

export const burpiRemindersRouter = Router();

// BurpiOpus sends this after any saved workout. We intentionally keep the
// reminder state separate from the old TrainingProfile so the two diaries do
// not affect one another.
burpiRemindersRouter.post("/complete", authMiddleware, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { id: true, username: true },
  });
  if (!user || !isDenrechUsername(user.username)) {
    res.status(403).json({ error: "private reminder" });
    return;
  }
  const completedDateKey = dateKeyInTimezone("Asia/Nicosia");
  await prisma.burpiReminder.upsert({
    where: { userId: user.id },
    update: { completedDateKey },
    create: { userId: user.id, completedDateKey },
  });
  res.json({ ok: true, completedDateKey });
});
