import { apiFetch } from '@/lib/auth/api';
import type {
  AssignableUser,
  CalendarEventItem,
  CalendarEventListResult,
  CalendarEventStatus,
  ConversationChannel,
  ConversationItem,
  ConversationListResult,
  ConversationState,
  CreateCalendarEventInput,
  CreateFollowUpInput,
  CreateLeadInput,
  DashboardSummary,
  FollowUpItem,
  FollowUpListResult,
  FollowUpStatus,
  LeadItem,
  LeadListResult,
  MessageItem,
  MessageListResult,
  PipelineView,
  UpdateCalendarEventInput,
  UpdateFollowUpInput,
} from './types';

/**
 * Resource API client. Reuses apiFetch from the auth layer, so every call:
 *  - sends the in-memory access token as a Bearer header;
 *  - transparently refreshes + replays once on a 401;
 *  - is tenant-scoped server-side (the token carries the tenant).
 */

export interface ListLeadsParams {
  search?: string;
  stageId?: string;
  ownerUserId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export function getDashboardSummary(signal?: AbortSignal): Promise<DashboardSummary> {
  return apiFetch<DashboardSummary>('/api/dashboard/summary', { method: 'GET' }, { signal });
}

export function listPipelines(signal?: AbortSignal): Promise<PipelineView[]> {
  return apiFetch<PipelineView[]>('/api/pipelines', { method: 'GET' }, { signal });
}

export function listLeads(params: ListLeadsParams = {}, signal?: AbortSignal): Promise<LeadListResult> {
  const query = toQuery({
    search: params.search,
    stageId: params.stageId,
    ownerUserId: params.ownerUserId,
    status: params.status,
    page: params.page,
    pageSize: params.pageSize,
  });
  return apiFetch<LeadListResult>(`/api/leads${query}`, { method: 'GET' }, { signal });
}

export function getLead(id: string, signal?: AbortSignal): Promise<LeadItem> {
  return apiFetch<LeadItem>(`/api/leads/${id}`, { method: 'GET' }, { signal });
}

export function createLead(input: CreateLeadInput): Promise<LeadItem> {
  return apiFetch<LeadItem>('/api/leads', { method: 'POST', body: JSON.stringify(input) });
}

export function moveLeadStage(id: string, stageId: string): Promise<LeadItem> {
  return apiFetch<LeadItem>(`/api/leads/${id}/stage`, {
    method: 'PATCH',
    body: JSON.stringify({ stageId }),
  });
}

// -- Users (Atendente responsável) --------------------------------------------

/**
 * Lists internal tenant users eligible as "Atendente responsável".
 * Tenant-scoped server-side (the token carries the tenant); never returns
 * users of another tenant and never returns Leads.
 */
export function listAssignableUsers(signal?: AbortSignal): Promise<AssignableUser[]> {
  return apiFetch<AssignableUser[]>('/api/users/assignable', { method: 'GET' }, { signal });
}

// -- Follow-ups ---------------------------------------------------------------

export interface ListFollowUpsParams {
  status?: FollowUpStatus;
  leadId?: string;
  ownerUserId?: string;
  from?: string;
  to?: string;
  /** Shortcut: status=PENDING and scheduledAt < now. Ignores status/from/to. */
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

export function listFollowUps(
  params: ListFollowUpsParams = {},
  signal?: AbortSignal,
): Promise<FollowUpListResult> {
  const query = toQuery({
    status: params.status,
    leadId: params.leadId,
    ownerUserId: params.ownerUserId,
    from: params.from,
    to: params.to,
    overdue: params.overdue === undefined ? undefined : String(params.overdue),
    page: params.page,
    pageSize: params.pageSize,
  });
  return apiFetch<FollowUpListResult>(`/api/follow-ups${query}`, { method: 'GET' }, { signal });
}

export function getFollowUp(id: string, signal?: AbortSignal): Promise<FollowUpItem> {
  return apiFetch<FollowUpItem>(`/api/follow-ups/${id}`, { method: 'GET' }, { signal });
}

export function createFollowUp(input: CreateFollowUpInput): Promise<FollowUpItem> {
  return apiFetch<FollowUpItem>('/api/follow-ups', { method: 'POST', body: JSON.stringify(input) });
}

export function updateFollowUp(id: string, input: UpdateFollowUpInput): Promise<FollowUpItem> {
  return apiFetch<FollowUpItem>(`/api/follow-ups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function completeFollowUp(id: string): Promise<FollowUpItem> {
  return apiFetch<FollowUpItem>(`/api/follow-ups/${id}/complete`, { method: 'PATCH' });
}

export function cancelFollowUp(id: string): Promise<FollowUpItem> {
  return apiFetch<FollowUpItem>(`/api/follow-ups/${id}/cancel`, { method: 'PATCH' });
}

export function rescheduleFollowUp(id: string, scheduledAt: string): Promise<FollowUpItem> {
  return apiFetch<FollowUpItem>(`/api/follow-ups/${id}/reschedule`, {
    method: 'PATCH',
    body: JSON.stringify({ scheduledAt }),
  });
}

// -- Calendar / Agenda ----------------------------------------------------------

export interface ListCalendarEventsParams {
  from?: string;
  to?: string;
  status?: CalendarEventStatus;
  leadId?: string;
  ownerUserId?: string;
  page?: number;
  pageSize?: number;
}

export function listCalendarEvents(
  params: ListCalendarEventsParams = {},
  signal?: AbortSignal,
): Promise<CalendarEventListResult> {
  const query = toQuery({
    from: params.from,
    to: params.to,
    status: params.status,
    leadId: params.leadId,
    ownerUserId: params.ownerUserId,
    page: params.page,
    pageSize: params.pageSize,
  });
  return apiFetch<CalendarEventListResult>(`/api/calendar/events${query}`, { method: 'GET' }, { signal });
}

export function getCalendarEvent(id: string, signal?: AbortSignal): Promise<CalendarEventItem> {
  return apiFetch<CalendarEventItem>(`/api/calendar/events/${id}`, { method: 'GET' }, { signal });
}

export function createCalendarEvent(input: CreateCalendarEventInput): Promise<CalendarEventItem> {
  return apiFetch<CalendarEventItem>('/api/calendar/events', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateCalendarEvent(
  id: string,
  input: UpdateCalendarEventInput,
): Promise<CalendarEventItem> {
  return apiFetch<CalendarEventItem>(`/api/calendar/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function completeCalendarEvent(id: string): Promise<CalendarEventItem> {
  return apiFetch<CalendarEventItem>(`/api/calendar/events/${id}/complete`, { method: 'PATCH' });
}

export function cancelCalendarEvent(id: string): Promise<CalendarEventItem> {
  return apiFetch<CalendarEventItem>(`/api/calendar/events/${id}/cancel`, { method: 'PATCH' });
}

// -- Conversations / Inbox ------------------------------------------------------

export interface ListConversationsParams {
  state?: ConversationState;
  channel?: ConversationChannel;
  assignedUserId?: string;
  unassigned?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function listConversations(
  params: ListConversationsParams = {},
  signal?: AbortSignal,
): Promise<ConversationListResult> {
  const query = toQuery({
    state: params.state,
    channel: params.channel,
    assignedUserId: params.assignedUserId,
    unassigned: params.unassigned === undefined ? undefined : String(params.unassigned),
    search: params.search,
    page: params.page,
    pageSize: params.pageSize,
  });
  return apiFetch<ConversationListResult>(`/api/conversations${query}`, { method: 'GET' }, { signal });
}

export function getConversation(id: string, signal?: AbortSignal): Promise<ConversationItem> {
  return apiFetch<ConversationItem>(`/api/conversations/${id}`, { method: 'GET' }, { signal });
}

/** Validated transition — the API rejects (409) any state not reachable from the current one. */
export function changeConversationState(id: string, state: ConversationState): Promise<ConversationItem> {
  return apiFetch<ConversationItem>(`/api/conversations/${id}/state`, {
    method: 'PATCH',
    body: JSON.stringify({ state }),
  });
}

/** Assigns/transfers to a user of the SAME tenant (server-enforced). */
export function assignConversation(id: string, userId: string): Promise<ConversationItem> {
  return apiFetch<ConversationItem>(`/api/conversations/${id}/assign`, {
    method: 'PATCH',
    body: JSON.stringify({ userId }),
  });
}

/** Idempotent if already unassigned. */
export function unassignConversation(id: string): Promise<ConversationItem> {
  return apiFetch<ConversationItem>(`/api/conversations/${id}/unassign`, { method: 'PATCH' });
}

// -- Messages -------------------------------------------------------------------

export interface ListMessagesParams {
  /** Load messages older than this message id (keyset pagination). */
  before?: string;
  limit?: number;
}

export function listMessages(
  conversationId: string,
  params: ListMessagesParams = {},
  signal?: AbortSignal,
): Promise<MessageListResult> {
  const query = toQuery({ before: params.before, limit: params.limit });
  return apiFetch<MessageListResult>(
    `/api/conversations/${conversationId}/messages${query}`,
    { method: 'GET' },
    { signal },
  );
}

/** Always OUTBOUND/AGENT, attributed to the caller — the API never accepts a client-chosen sender. */
export function sendMessage(conversationId: string, body: string): Promise<MessageItem> {
  return apiFetch<MessageItem>(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}
