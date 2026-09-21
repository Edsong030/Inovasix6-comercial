import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContactsModule } from '../contacts/contacts.module';
import { ConversationIngressService } from './conversation-ingress.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { ConversationInboundController } from './inbound/conversation-inbound.controller';
import { InboundCredentialsService } from './inbound/inbound-credentials.service';
import { InboundServiceGuard } from './inbound/inbound-service.guard';

@Module({
  imports: [AuthModule, ContactsModule],
  controllers: [ConversationsController, ConversationInboundController],
  providers: [ConversationsService, ConversationIngressService, InboundCredentialsService, InboundServiceGuard],
  exports: [ConversationsService, ConversationIngressService],
})
export class ConversationsModule {}
