-- Sole statement in this migration so it runs outside an implicit
-- transaction: CREATE INDEX CONCURRENTLY errors inside one. The computer view
-- reads a bot's latest run on every status poll, and runs is a hot table.
CREATE INDEX CONCURRENTLY "runs_botId_createdAt_idx" ON "runs"("botId", "createdAt");
