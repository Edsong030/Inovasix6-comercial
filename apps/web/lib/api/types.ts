/** Shapes mirrored from the API contract (dashboard, leads, pipelines). */

export type LeadStatus = 'OPEN' | 'WON' | 'LOST';

export interface DashboardSummary {
  metrics: {
    newLeads: number;
    pipelineValue: number;
    scheduledMeetings: number;
    monthlySales: number;
    conversionRate: number;
  };
  funnel: Array<{ id: string; label: string; count: number; percent: number }>;
  followUpsToday: Array<{
    id: string;
    name: string;
    company: string | null;
    time: string;
    reason: string;
  }>;
  agendaToday: Array<{ id: string; name: string; time: string }>;
  recentActivity: Array<{
    id: string;
    action: string;
    entity: string;
    entityId: string | null;
    time: string;
  }>;
}

export interface LeadItem {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  amountCents: number | null;
  status: LeadStatus;
  stageId: string;
  stageName: string;
  ownerName: string | null;
  source: string | null;
  interest: string | null;
  lastInteractionAt: string;
  nextActionAt: string | null;
  createdAt: string;
}

export interface LeadListResult {
  items: LeadItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PipelineStageView {
  id: string;
  name: string;
  position: number;
}

export interface PipelineView {
  id: string;
  name: string;
  isDefault: boolean;
  stages: PipelineStageView[];
}

export interface CreateLeadInput {
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  amountCents?: number;
  stageId?: string;
  ownerUserId?: string;
  source?: string;
  interest?: string;
}

// -- Users (internal tenant users, eligible as "Atendente responsável") -------

export type UserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED';

/**
 * Internal tenant user eligible to be assigned as the "Atendente responsável".
 * This is NEVER a Lead/Cliente — it is an internal user of the same tenant.
 */
export interface AssignableUser {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  roleCodes: string[];
}

// -- Follow-ups ---------------------------------------------------------------

export type FollowUpStatus = 'PENDING' | 'COMPLETED' | 'CANCELED';
export type FollowUpType = 'CALL' | 'EMAIL' | 'WHATSAPP' | 'MEETING' | 'OTHER';
export type FollowUpPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FollowUpItem {
  id: string;
  leadId: string;
  leadName: string;
  leadCompany: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  title: string;
  description: string | null;
  type: FollowUpType;
  priority: FollowUpPriority;
  status: FollowUpStatus;
  scheduledAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  /** Derived by the API: status = PENDING and scheduledAt < now. */
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FollowUpListResult {
  items: FollowUpItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateFollowUpInput {
  leadId: string;
  ownerUserId?: string;
  title: string;
  description?: string;
  type?: FollowUpType;
  priority?: FollowUpPriority;
  scheduledAt: string;
}

export interface UpdateFollowUpInput {
  leadId?: string;
  ownerUserId?: string;
  title?: string;
  description?: string;
  type?: FollowUpType;
  priority?: FollowUpPriority;
}

// -- Calendar / Agenda ---------------------------------------------------------

export type CalendarEventStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELED';
export type CalendarEventType = 'MEETING' | 'CALL' | 'TASK' | 'OTHER';

export interface CalendarEventItem {
  id: string;
  leadId: string | null;
  leadName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  title: string;
  description: string | null;
  type: CalendarEventType;
  status: CalendarEventStatus;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventListResult {
  items: CalendarEventItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateCalendarEventInput {
  leadId?: string;
  ownerUserId?: string;
  title: string;
  description?: string;
  type?: CalendarEventType;
  startsAt: string;
  endsAt?: string;
}

export interface UpdateCalendarEventInput {
  leadId?: string;
  ownerUserId?: string;
  title?: string;
  description?: string;
  type?: CalendarEventType;
  startsAt?: string;
  endsAt?: string;
}

// -- Conversations / Inbox -----------------------------------------------------

/**
 * Mirrors Prisma's ConversationState exactly (apps/api/prisma/schema.prisma).
 * HUMANO_ATENDENDO is only ever reached as a side effect of assigning the
 * conversation — never a direct PATCH .../state target (see
 * CONVERSATION_STATE_TRANSITIONS in InboxView.tsx, which mirrors the
 * backend's ALLOWED_TRANSITIONS).
 */
export type ConversationState = 'AI_ATENDENDO' | 'AGUARDANDO_HUMANO' | 'HUMANO_ATENDENDO' | 'ENCERRADA';

/** Mirrors Prisma's ConversationChannel. Only MANUAL is reachable today — no provider integration exists yet. */
export type ConversationChannel = 'MANUAL' | 'WHATSAPP' | 'INSTAGRAM' | 'FACEBOOK' | 'WEBCHAT';

export interface ConversationItem {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /** Only presence is known here — the API does not join Lead, so no name/company is available. */
  leadId: string | null;
  state: ConversationState;
  channel: ConversationChannel;
  subject: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListResult {
  items: ConversationItem[];
  total: number;
  page: number;
  pageSize: number;
}

// -- Messages -------------------------------------------------------------------

export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
export type MessageSenderType = 'CUSTOMER' | 'AGENT' | 'SYSTEM' | 'AI';

export interface MessageItem {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  status: MessageStatus;
  senderType: MessageSenderType;
  senderUserId: string | null;
  senderUserName: string | null;
  body: string | null;
  externalId: string | null;
  createdAt: string;
}

export interface MessageListResult {
  /** Chronological order (oldest first), as returned by the API. */
  items: MessageItem[];
  /** Pass as `before` to load the next (older) page. Null when there is none. */
  nextCursor: string | null;
  hasMore: boolean;
}
