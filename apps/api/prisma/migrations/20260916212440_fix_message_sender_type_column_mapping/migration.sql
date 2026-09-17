/*
  Warnings:

  - You are about to drop the column `senderType` on the `messages` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "messages" DROP COLUMN "senderType",
ADD COLUMN     "sender_type" "MessageSenderType" NOT NULL DEFAULT 'CUSTOMER';
