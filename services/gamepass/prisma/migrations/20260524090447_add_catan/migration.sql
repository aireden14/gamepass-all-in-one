-- CreateTable
CREATE TABLE "CatanGame" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "maxPlayers" INTEGER NOT NULL DEFAULT 4,
    "hostId" INTEGER NOT NULL,
    "winnerId" INTEGER,
    "boardJson" TEXT NOT NULL,
    "stateJson" TEXT NOT NULL,
    "settingsJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "CatanGame_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CatanGame_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CatanPlayer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "gameId" TEXT NOT NULL,
    "userId" INTEGER,
    "seat" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "botLevel" TEXT,
    "hasLeft" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "CatanPlayer_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "CatanGame" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CatanPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CatanPlayer_gameId_seat_key" ON "CatanPlayer"("gameId", "seat");
