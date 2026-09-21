import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContactsModule } from '../contacts/contacts.module';
import { ConversationIngressService } from './conversation-ingress.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [AuthModule, ContactsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationIngressService],
  exports: [ConversationsService, ConversationIngressService],
})
export class ConversationsModule {}
