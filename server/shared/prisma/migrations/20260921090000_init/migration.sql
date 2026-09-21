-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "AccessMode" AS ENUM ('FREE', 'PAYMENT_REQUIRED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'SUPERADMIN');

-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AgentSessionState" AS ENUM ('STARTING', 'ACTIVE', 'IDLE', 'QUEUED', 'ENDED');

-- CreateEnum
CREATE TYPE "AgentSessionEndReason" AS ENUM ('USER_QUIT', 'IDLE_TIMEOUT', 'REVOKED', 'EXPIRED', 'OUT_OF_HOURS', 'SERVER_RESTART', 'EVICTED', 'ERROR');

-- CreateEnum
CREATE TYPE "TurnRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL');

-- CreateEnum
CREATE TYPE "QueueOutcome" AS ENUM ('PROMOTED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('OWNER', 'SYSTEM', 'ACCOUNT');

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING',
    "role" "Role" NOT NULL DEFAULT 'USER',
    "accessMode" "AccessMode" NOT NULL DEFAULT 'FREE',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "deletedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grant" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_request" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "message" TEXT,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "sourceIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "access_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'login',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "requestIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_session" (
    "id" TEXT NOT NULL,
    "authSessionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "state" "AgentSessionState" NOT NULL DEFAULT 'STARTING',
    "seatNo" INTEGER,
    "projectLabel" TEXT,
    "clientRootHash" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" "AgentSessionEndReason",
    "resumeTokenHash" TEXT,

    CONSTRAINT "agent_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_turn" (
    "id" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "role" "TurnRole" NOT NULL,
    "contentRef" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "modelMs" INTEGER NOT NULL DEFAULT 0,
    "toolCallsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_queue_entry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "authSessionId" TEXT NOT NULL,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "outcome" "QueueOutcome",

    CONSTRAINT "session_queue_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "razorpayOrderId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "grantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "serviceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maintenanceMessage" TEXT,
    "maxConcurrentSessions" INTEGER NOT NULL DEFAULT 8,
    "idleReleaseMinutes" INTEGER NOT NULL DEFAULT 15,
    "whenFull" TEXT NOT NULL DEFAULT 'QUEUE',
    "maxQueueLength" INTEGER NOT NULL DEFAULT 5,
    "maxQueueWaitMinutes" INTEGER NOT NULL DEFAULT 10,
    "maxConcurrentInference" INTEGER NOT NULL DEFAULT 4,
    "perUserMsgsPerMin" INTEGER NOT NULL DEFAULT 20,
    "perUserTokensPerDay" INTEGER NOT NULL DEFAULT 2000000,
    "sessionMaxTtlHours" INTEGER NOT NULL DEFAULT 12,
    "openHoursJson" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "service_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_email_key" ON "account"("email");

-- CreateIndex
CREATE INDEX "account_status_idx" ON "account"("status");

-- CreateIndex
CREATE INDEX "access_grant_accountId_expiresAt_idx" ON "access_grant"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "access_grant_expiresAt_idx" ON "access_grant"("expiresAt");

-- CreateIndex
CREATE INDEX "access_request_status_createdAt_idx" ON "access_request"("status", "createdAt");

-- CreateIndex
CREATE INDEX "access_request_email_idx" ON "access_request"("email");

-- CreateIndex
CREATE INDEX "otp_challenge_email_createdAt_idx" ON "otp_challenge"("email", "createdAt");

-- CreateIndex
CREATE INDEX "otp_challenge_expiresAt_idx" ON "otp_challenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_tokenHash_key" ON "auth_session"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_session_accountId_idx" ON "auth_session"("accountId");

-- CreateIndex
CREATE INDEX "auth_session_expiresAt_idx" ON "auth_session"("expiresAt");

-- CreateIndex
CREATE INDEX "agent_session_state_idx" ON "agent_session"("state");

-- CreateIndex
CREATE INDEX "agent_session_accountId_startedAt_idx" ON "agent_session"("accountId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_session_lastActivityAt_idx" ON "agent_session"("lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_turn_agentSessionId_ord_key" ON "agent_turn"("agentSessionId", "ord");

-- CreateIndex
CREATE INDEX "session_queue_entry_enqueuedAt_idx" ON "session_queue_entry"("enqueuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_razorpayOrderId_key" ON "payment"("razorpayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_razorpayPaymentId_key" ON "payment"("razorpayPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_grantId_key" ON "payment"("grantId");

-- CreateIndex
CREATE INDEX "payment_accountId_idx" ON "payment"("accountId");

-- CreateIndex
CREATE INDEX "audit_event_createdAt_idx" ON "audit_event"("createdAt");

-- CreateIndex
CREATE INDEX "audit_event_actorType_actorId_idx" ON "audit_event"("actorType", "actorId");

-- CreateIndex
CREATE INDEX "audit_event_targetType_targetId_idx" ON "audit_event"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_authSessionId_fkey" FOREIGN KEY ("authSessionId") REFERENCES "auth_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_turn" ADD CONSTRAINT "agent_turn_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "agent_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_queue_entry" ADD CONSTRAINT "session_queue_entry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "access_grant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

