-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('MANUAL', 'WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'WEBCHAT');

-- CreateEnum
CREATE TYPE "MessageSenderType" AS ENUM ('CUSTOMER', 'AGENT', 'SYSTEM', 'AI');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "assigned_user_id" UUID,
ADD COLUMN     "channel" "ConversationChannel" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "last_message_at" TIMESTAMP(3),
ADD COLUMN     "subject" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "senderType" "MessageSenderType" NOT NULL DEFAULT 'CUSTOMER',
ADD COLUMN     "sender_user_id" UUID;

-- CreateIndex
CREATE INDEX "conversations_tenant_id_state_last_message_at_idx" ON "conversations"("tenant_id", "state", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_assigned_user_id_state_idx" ON "conversations"("tenant_id", "assigned_user_id", "state");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_channel_idx" ON "conversations"("tenant_id", "channel");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_assigned_user_id_fkey" FOREIGN KEY ("tenant_id", "assigned_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_sender_user_id_fkey" FOREIGN KEY ("tenant_id", "sender_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
