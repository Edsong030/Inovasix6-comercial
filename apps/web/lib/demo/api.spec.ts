/**
 * Unit tests for the Inbox demo layer (STEP 4 — GitHub Pages Inbox
 * simulation). Every test gets a FRESH module instance via jest.resetModules,
 * so the module-level `inboxMemory` singleton always starts from the
 * fixtures — same guarantee a fresh page load gives in the browser.
 */

import type {
  AssignableUser,
  ConversationItem,
  ConversationListResult,
  MessageItem,
  MessageListResult,
} from '@/lib/api/types';

type DemoRequestFn = (path: string, init: RequestInit) => Promise<Response>;
type ErrorBody = { message: string };

let demoRequest: DemoRequestFn;

function freshDemo(): void {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./api') as typeof import('./api');
  demoRequest = mod.demoRequest;
}

async function json<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

beforeEach(() => {
  freshDemo();
});

describe('Inbox fixtures', () => {
  it('seeds 4 conversations covering every ConversationState and the WhatsApp/Webchat/Instagram/Manual channels', async () => {
    const body = await json<ConversationListResult>(await demoRequest('/api/conversations', {}));
    expect(body.items).toHaveLength(4);
    expect(body.items.map((c) => c.state).sort()).toEqual(['AGUARDANDO_HUMANO', 'AI_ATENDENDO', 'ENCERRADA', 'HUMANO_ATENDENDO']);
    expect(body.items.map((c) => c.channel).sort()).toEqual(['INSTAGRAM', 'MANUAL', 'WEBCHAT', 'WHATSAPP']);
  });

  it('uses fictitious, deterministic ids — never a UUID', async () => {
    const body = await json<ConversationListResult>(await demoRequest('/api/conversations', {}));
    for (const conv of body.items) {
      expect(conv.id).toMatch(/^demo-conv-\d+$/);
    }
  });

  it('every conversation has a coherent, isolated message history (customer + AI/human, with timestamps)', async () => {
    const list = await json<ConversationListResult>(await demoRequest('/api/conversations', {}));
    const seenIds = new Set<string>();
    for (const conv of list.items) {
      const messages = await json<MessageListResult>(await demoRequest(`/api/conversations/${conv.id}/messages`, {}));
      expect(messages.items.length).toBeGreaterThan(0);
      for (const m of messages.items) {
        expect(m.conversationId).toBe(conv.id);
        expect(typeof m.createdAt).toBe('string');
        expect(seenIds.has(m.id)).toBe(false); // isolation: no message id leaks across conversations
        seenIds.add(m.id);
      }
      // At least one CUSTOMER message per conversation (a real inbound thread).
      expect(messages.items.some((m) => m.senderType === 'CUSTOMER')).toBe(true);
    }
  });

  it('conv-1 (WhatsApp) demonstrates the bot still attending, unassigned', async () => {
    const conv = await json<ConversationItem>(await demoRequest('/api/conversations/demo-conv-1', {}));
    expect(conv.channel).toBe('WHATSAPP');
    expect(conv.state).toBe('AI_ATENDENDO');
    expect(conv.assignedUserId).toBeNull();
  });

  it('conv-3 (Instagram) demonstrates a human already attending, assigned to a colleague', async () => {
    const conv = await json<ConversationItem>(await demoRequest('/api/conversations/demo-conv-3', {}));
    expect(conv.channel).toBe('INSTAGRAM');
    expect(conv.state).toBe('HUMANO_ATENDENDO');
    expect(conv.assignedUserId).toBe('demo-agent-bruna');
  });

  it('conv-4 (Manual) demonstrates a closed conversation', async () => {
    const conv = await json<ConversationItem>(await demoRequest('/api/conversations/demo-conv-4', {}));
    expect(conv.channel).toBe('MANUAL');
    expect(conv.state).toBe('ENCERRADA');
  });
});

describe('listConversations filters', () => {
  it('search matches contact name (case-insensitive)', async () => {
    const body = await json<ConversationListResult>(await demoRequest('/api/conversations?search=beatriz', {}));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].contactName).toBe('Beatriz Andrade');
  });

  it('state filter narrows results', async () => {
    const body = await json<ConversationListResult>(await demoRequest('/api/conversations?state=ENCERRADA', {}));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].state).toBe('ENCERRADA');
  });

  it('channel filter narrows results', async () => {
    const body = await json<ConversationListResult>(await demoRequest('/api/conversations?channel=INSTAGRAM', {}));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].channel).toBe('INSTAGRAM');
  });

  it('a search with no match returns an empty list, not an error', async () => {
    const body = await json<ConversationListResult>(await demoRequest('/api/conversations?search=nao-existe-xyz', {}));
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe('sendMessage', () => {
  it('appends an AGENT/OUTBOUND message attributed to the signed-in demo user and it appears immediately', async () => {
    const before = await json<MessageListResult>(await demoRequest('/api/conversations/demo-conv-1/messages', {}));

    const res = await demoRequest('/api/conversations/demo-conv-1/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'Olá, aqui é o atendimento.' }),
    });
    expect(res.status).toBe(201);
    const created = await json<MessageItem>(res);
    expect(created.senderType).toBe('AGENT');
    expect(created.direction).toBe('OUTBOUND');
    expect(created.status).toBe('SENT');
    expect(created.senderUserId).toBe('demo-user');
    expect(created.body).toBe('Olá, aqui é o atendimento.');

    const after = await json<MessageListResult>(await demoRequest('/api/conversations/demo-conv-1/messages', {}));
    expect(after.items).toHaveLength(before.items.length + 1);
    expect(after.items[after.items.length - 1].id).toBe(created.id);
  });

  it('bumps the conversation lastMessageAt so the list re-sorts to the top', async () => {
    const convBefore = await json<ConversationItem>(await demoRequest('/api/conversations/demo-conv-1', {}));
    await demoRequest('/api/conversations/demo-conv-1/messages', { method: 'POST', body: JSON.stringify({ body: 'x' }) });
    const convAfter = await json<ConversationItem>(await demoRequest('/api/conversations/demo-conv-1', {}));
    expect(new Date(convAfter.lastMessageAt!).getTime()).toBeGreaterThanOrEqual(new Date(convBefore.lastMessageAt!).getTime());
  });

  it('rejects sending on a closed (ENCERRADA) conversation with 409, mirroring the real API', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-4/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(409);
  });

  it('404s for an unknown conversation id', async () => {
    const res = await demoRequest('/api/conversations/does-not-exist/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('assign / unassign', () => {
  it('assign sets assignedUser* and moves the conversation into HUMANO_ATENDENDO', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-2/assign', {
      method: 'PATCH',
      body: JSON.stringify({ userId: 'demo-user' }),
    });
    expect(res.status).toBe(200);
    const updated = await json<ConversationItem>(res);
    expect(updated.assignedUserId).toBe('demo-user');
    expect(updated.assignedUserName).toBe('Edson Ribeiro');
    expect(updated.state).toBe('HUMANO_ATENDENDO');
  });

  it('rejects an unknown userId with 400', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-2/assign', {
      method: 'PATCH',
      body: JSON.stringify({ userId: 'not-a-real-agent' }),
    });
    expect(res.status).toBe(400);
  });

  it('assign is rejected on a closed conversation with 409', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-4/assign', {
      method: 'PATCH',
      body: JSON.stringify({ userId: 'demo-user' }),
    });
    expect(res.status).toBe(409);
  });

  it('unassign releases HUMANO_ATENDENDO back to AGUARDANDO_HUMANO', async () => {
    await demoRequest('/api/conversations/demo-conv-2/assign', { method: 'PATCH', body: JSON.stringify({ userId: 'demo-user' }) });
    const res = await demoRequest('/api/conversations/demo-conv-2/unassign', { method: 'PATCH' });
    const updated = await json<ConversationItem>(res);
    expect(updated.assignedUserId).toBeNull();
    expect(updated.state).toBe('AGUARDANDO_HUMANO');
  });

  it('unassign is idempotent when already unassigned', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-1/unassign', { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect((await json<ConversationItem>(res)).assignedUserId).toBeNull();
  });
});

describe('changeConversationState (mirrors CONVERSATION_STATE_TRANSITIONS)', () => {
  it('allows AI_ATENDENDO -> AGUARDANDO_HUMANO', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-1/state', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'AGUARDANDO_HUMANO' }),
    });
    expect(res.status).toBe(200);
    expect((await json<ConversationItem>(res)).state).toBe('AGUARDANDO_HUMANO');
  });

  it('rejects a transition outside the allowed map with 409', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-1/state', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'HUMANO_ATENDENDO' }),
    });
    expect(res.status).toBe(409);
  });

  it('reopens ENCERRADA -> AGUARDANDO_HUMANO', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-4/state', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'AGUARDANDO_HUMANO' }),
    });
    expect(res.status).toBe(200);
  });

  it('is idempotent when the target equals the current state', async () => {
    const res = await demoRequest('/api/conversations/demo-conv-1/state', {
      method: 'PATCH',
      body: JSON.stringify({ state: 'AI_ATENDENDO' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('assignable users', () => {
  it('lists fictional agents, including the signed-in demo user, compatible with AssignableUser', async () => {
    const body = await json<AssignableUser[]>(await demoRequest('/api/users/assignable', {}));
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((u) => u.id)).toContain('demo-user');
    for (const agent of body) {
      expect(typeof agent.id).toBe('string');
      expect(typeof agent.name).toBe('string');
      expect(['ACTIVE', 'INVITED', 'SUSPENDED']).toContain(agent.status);
    }
  });
});

describe('unknown conversation id', () => {
  it('GET /api/conversations/:id 404s', async () => {
    const res = await demoRequest('/api/conversations/not-a-real-id', {});
    expect(res.status).toBe(404);
    expect((await json<ErrorBody>(res)).message).toEqual(expect.any(String));
  });
});

describe('localStorage persistence (inovasix6-demo-inbox-v1)', () => {
  function createFakeLocalStorage() {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    };
  }

  const globalRecord = global as unknown as Record<string, unknown>;
  let fakeStorage: ReturnType<typeof createFakeLocalStorage>;
  const originalWindow = globalRecord.window;

  beforeEach(() => {
    fakeStorage = createFakeLocalStorage();
    globalRecord.window = { localStorage: fakeStorage };
  });

  afterAll(() => {
    globalRecord.window = originalWindow;
  });

  it('persists a sent message so it survives a reload (fresh module instance, same storage)', async () => {
    await demoRequest('/api/conversations/demo-conv-1/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'Mensagem persistida' }),
    });
    expect(fakeStorage.getItem('inovasix6-demo-inbox-v1')).toBeTruthy();

    // Simulate F5: fresh module instance, same (fake) browser storage.
    freshDemo();
    const after = await json<MessageListResult>(await demoRequest('/api/conversations/demo-conv-1/messages', {}));
    expect(after.items.some((m) => m.body === 'Mensagem persistida')).toBe(true);
  });

  it('persists an assignment across reload', async () => {
    await demoRequest('/api/conversations/demo-conv-2/assign', { method: 'PATCH', body: JSON.stringify({ userId: 'demo-agent-lucas' }) });
    freshDemo();
    const conv = await json<ConversationItem>(await demoRequest('/api/conversations/demo-conv-2', {}));
    expect(conv.assignedUserId).toBe('demo-agent-lucas');
  });

  it('recovers from corrupted JSON in storage by falling back to fixtures, without throwing', async () => {
    fakeStorage.setItem('inovasix6-demo-inbox-v1', '{ this is not valid json');
    freshDemo();
    const res = await demoRequest('/api/conversations', {});
    expect(res.status).toBe(200);
    expect((await json<ConversationListResult>(res)).items).toHaveLength(4);
  });

  it('recovers from a validly-parsed but wrong-shaped payload (missing conversations array)', async () => {
    fakeStorage.setItem('inovasix6-demo-inbox-v1', JSON.stringify({ nope: true }));
    freshDemo();
    const res = await demoRequest('/api/conversations', {});
    expect((await json<ConversationListResult>(res)).items).toHaveLength(4);
  });
});
