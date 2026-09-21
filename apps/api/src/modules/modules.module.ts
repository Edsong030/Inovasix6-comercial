import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { ContactsModule } from './contacts/contacts.module';
import { ConversationsModule } from './conversations/conversations.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DeliveryModule } from './delivery/delivery.module';
import { FilesModule } from './files/files.module';
import { FollowupsModule } from './followups/followups.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LeadsModule } from './leads/leads.module';
import { MessagesModule } from './messages/messages.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { AiModule } from './ai/ai.module';

@Module({ imports: [AuthModule, TenantsModule, UsersModule, ContactsModule, LeadsModule, PipelinesModule, ConversationsModule, MessagesModule, WhatsappModule, AiModule, KnowledgeModule, FollowupsModule, CalendarModule, DashboardModule, DeliveryModule, AuditModule, IntegrationsModule, FilesModule] })
export class ModulesModule {}
