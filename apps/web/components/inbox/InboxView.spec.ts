import {
  buildSendMessageInput,
  CONVERSATION_STATE_LABELS,
  initialsFromName,
  isMessagesDataForConversation,
  nextStateOptions,
  resolveAssigneeChange,
  resolveSelectedConversation,
} from './InboxView';
import type { ConversationItem, MessageItem, MessageListResult } from '@/lib/api/types';

/**
 * Unit tests for the pure logic InboxView is built on (STEP 3 — connect the
 * Inbox to the real Conversations/Messages API). No React rendering (the web
 * harness is node-only, no @testing-library) — same convention as
 * FollowupsView.spec.ts / AgendaView.spec.ts: extract the decision logic,
 * test that directly, and let the component be a thin, visually-inspected
 * consumer of it.
 */

function makeConversation(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: 'conv-1',
    contactId: 'contact-1',
    contactName: 'Maria Silva',
    contactPhone: '+5511900000000',
    contactEmail: 'maria@exemplo.test',
    leadId: null,
    state: 'AGUARDANDO_HUMANO',
    channel: 'MANUAL',
    subject: null,
    assignedUserId: null,
    assignedUserName: null,
    lastMessageAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    direction: 'OUTBOUND',
    status: 'SENT',
    senderType: 'AGENT',
    senderUserId: 'user-1',
    senderUserName: 'Ana',
    body: 'Olá!',
    externalId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('1/2. resolveSelectedConversation (list load + selection)', () => {
  it('resolves the conversation matching the given id', () => {
    const items = [makeConversation({ id: 'a' }), makeConversation({ id: 'b' })];
    expect(resolveSelectedConversation(items, 'b')?.id).toBe('b');
  });

  it('auto-selects the first conversation when nothing is selected yet (matches the old default behaviour)', () => {
    const items = [makeConversation({ id: 'a' }), makeConversation({ id: 'b' })];
    expect(resolveSelectedConversation(items, '')?.id).toBe('a');
  });

  it('falls back to the first item when the previously selected id no longer exists (e.g. after a search/reload)', () => {
    const items = [makeConversation({ id: 'a' }), makeConversation({ id: 'b' })];
    expect(resolveSelectedConversation(items, 'gone')?.id).toBe('a');
  });

  it('returns undefined for an empty list', () => {
    expect(resolveSelectedConversation([], 'anything')).toBeUndefined();
  });
});

describe('6/7. buildSendMessageInput (composer validation)', () => {
  it('returns the trimmed body for a valid message', () => {
    expect(buildSendMessageInput('  Olá, tudo bem?  ')).toBe('Olá, tudo bem?');
  });

  it('blocks an empty message', () => {
    expect(buildSendMessageInput('')).toBeNull();
  });

  it('blocks a whitespace-only message', () => {
    expect(buildSendMessageInput('   \n\t  ')).toBeNull();
  });
});

describe('9. resolveAssigneeChange (Atendente responsável select)', () => {
  it('maps a chosen user id to an assign action', () => {
    expect(resolveAssigneeChange('user-42')).toEqual({ action: 'assign', userId: 'user-42' });
  });

  it('maps the empty ("Nenhum") option to an unassign action', () => {
    expect(resolveAssigneeChange('')).toEqual({ action: 'unassign' });
  });
});

describe('10. nextStateOptions (mirrors the backend ALLOWED_TRANSITIONS exactly)', () => {
  it('AI_ATENDENDO can move to AGUARDANDO_HUMANO or ENCERRADA', () => {
    expect(nextStateOptions('AI_ATENDENDO')).toEqual(['AGUARDANDO_HUMANO', 'ENCERRADA']);
  });

  it('AGUARDANDO_HUMANO can only be closed', () => {
    expect(nextStateOptions('AGUARDANDO_HUMANO')).toEqual(['ENCERRADA']);
  });

  it('HUMANO_ATENDENDO can only be closed (never a direct manual target itself)', () => {
    expect(nextStateOptions('HUMANO_ATENDENDO')).toEqual(['ENCERRADA']);
  });

  it('ENCERRADA can only be reopened to AGUARDANDO_HUMANO', () => {
    expect(nextStateOptions('ENCERRADA')).toEqual(['AGUARDANDO_HUMANO']);
  });

  it('no option ever offers HUMANO_ATENDENDO as a manual target — only `assign` can enter it', () => {
    const allOffered = (['AI_ATENDENDO', 'AGUARDANDO_HUMANO', 'HUMANO_ATENDENDO', 'ENCERRADA'] as const).flatMap(
      (state) => nextStateOptions(state),
    );
    expect(allOffered).not.toContain('HUMANO_ATENDENDO');
  });

  it('every state has a real, existing label (no fabricated visual state)', () => {
    for (const state of ['AI_ATENDENDO', 'AGUARDANDO_HUMANO', 'HUMANO_ATENDENDO', 'ENCERRADA'] as const) {
      expect(CONVERSATION_STATE_LABELS[state].label).toEqual(expect.any(String));
    }
  });
});

describe('3/4/11. isMessagesDataForConversation (loading/empty/race-condition guard)', () => {
  const emptyResult: MessageListResult = { items: [], nextCursor: null, hasMore: false };

  it('is false while nothing has loaded yet (null data) — renders as loading, not as empty', () => {
    expect(isMessagesDataForConversation(null, 'conv-1')).toBe(false);
  });

  it('is true for a conversation truly without messages (empty is safe, not stale)', () => {
    expect(isMessagesDataForConversation(emptyResult, 'conv-1')).toBe(true);
  });

  it('is true when the loaded messages belong to the currently selected conversation', () => {
    const data: MessageListResult = { items: [makeMessage({ conversationId: 'conv-1' })], nextCursor: null, hasMore: false };
    expect(isMessagesDataForConversation(data, 'conv-1')).toBe(true);
  });

  it('is false when the loaded messages belong to a DIFFERENT (previous) conversation — the race-condition guard', () => {
    const dataForPreviousConversation: MessageListResult = {
      items: [makeMessage({ conversationId: 'conv-old' })],
      nextCursor: null,
      hasMore: false,
    };
    expect(isMessagesDataForConversation(dataForPreviousConversation, 'conv-new')).toBe(false);
  });
});

describe('initialsFromName (conversation list / details avatar)', () => {
  it('takes the first letter of up to two names', () => {
    expect(initialsFromName('Maria Silva')).toBe('MS');
  });

  it('handles a single name', () => {
    expect(initialsFromName('Maria')).toBe('M');
  });

  it('falls back to "?" when the contact has no name (never fabricates one)', () => {
    expect(initialsFromName(null)).toBe('?');
  });
});
