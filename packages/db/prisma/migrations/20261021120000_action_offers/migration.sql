-- Action cards: a bot's one-tap offers of its next step.
ALTER TABLE "user" ADD COLUMN "actionOfferSettings" JSONB;

-- CreateTable
CREATE TABLE "action_offers" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "skillSource" JSONB,
    "status" TEXT NOT NULL DEFAULT 'held',
    "closingRunId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "takenRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_offers_spaceId_userId_status_expiresAt_idx" ON "action_offers"("spaceId", "userId", "status", "expiresAt");
CREATE INDEX "action_offers_threadId_botId_status_idx" ON "action_offers"("threadId", "botId", "status");
CREATE INDEX "action_offers_runId_status_idx" ON "action_offers"("runId", "status");

-- AddForeignKey
ALTER TABLE "action_offers" ADD CONSTRAINT "action_offers_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "action_offers" ADD CONSTRAINT "action_offers_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "action_offers" ADD CONSTRAINT "action_offers_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "action_offers" ADD CONSTRAINT "action_offers_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "action_offers" ADD CONSTRAINT "action_offers_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
