-- CreateEnum
CREATE TYPE "ActivityLogSource" AS ENUM ('litellm_spend_logs', 'loom_ingest', 'manual');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "defaultProjectId" TEXT;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "teamId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "teamId" TEXT,
    "keyId" TEXT,
    "keyAlias" TEXT,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "requestId" TEXT,
    "projectId" TEXT,
    "projectName" TEXT,
    "clientName" TEXT,
    "clientVersion" TEXT,
    "source" "ActivityLogSource" NOT NULL DEFAULT 'litellm_spend_logs',
    "status" "UsageStatus" NOT NULL,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "category" TEXT,
    "promptPreview" TEXT,
    "completionPreview" TEXT,
    "promptContent" TEXT,
    "completionContent" TEXT,
    "redactionApplied" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_teamId_slug_key" ON "Project"("teamId", "slug");
CREATE INDEX "Project_teamId_idx" ON "Project"("teamId");
CREATE INDEX "Project_slug_idx" ON "Project"("slug");
CREATE INDEX "ApiKey_defaultProjectId_idx" ON "ApiKey"("defaultProjectId");
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");
CREATE INDEX "ActivityLog_expiresAt_idx" ON "ActivityLog"("expiresAt");
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");
CREATE INDEX "ActivityLog_teamId_createdAt_idx" ON "ActivityLog"("teamId", "createdAt");
CREATE INDEX "ActivityLog_projectId_createdAt_idx" ON "ActivityLog"("projectId", "createdAt");
CREATE INDEX "ActivityLog_keyAlias_createdAt_idx" ON "ActivityLog"("keyAlias", "createdAt");
CREATE INDEX "ActivityLog_model_createdAt_idx" ON "ActivityLog"("model", "createdAt");
CREATE INDEX "ActivityLog_provider_createdAt_idx" ON "ActivityLog"("provider", "createdAt");
CREATE INDEX "ActivityLog_status_createdAt_idx" ON "ActivityLog"("status", "createdAt");
CREATE INDEX "ActivityLog_clientName_createdAt_idx" ON "ActivityLog"("clientName", "createdAt");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_defaultProjectId_fkey" FOREIGN KEY ("defaultProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
