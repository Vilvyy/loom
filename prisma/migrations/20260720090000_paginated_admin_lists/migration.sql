-- Support stable cursor pagination for every admin list ordered by createdAt.
CREATE INDEX "User_createdAt_id_idx" ON "User"("createdAt" DESC, "id" DESC);
CREATE INDEX "ApiKey_createdAt_id_idx" ON "ApiKey"("createdAt" DESC, "id" DESC);
CREATE INDEX "Project_createdAt_id_idx" ON "Project"("createdAt" DESC, "id" DESC);
CREATE INDEX "ActivityLog_createdAt_id_idx" ON "ActivityLog"("createdAt" DESC, "id" DESC);
CREATE INDEX "BudgetLimit_createdAt_id_idx" ON "BudgetLimit"("createdAt" DESC, "id" DESC);
CREATE INDEX "Provider_createdAt_id_idx" ON "Provider"("createdAt" DESC, "id" DESC);
CREATE INDEX "ModelAlias_createdAt_id_idx" ON "ModelAlias"("createdAt" DESC, "id" DESC);
