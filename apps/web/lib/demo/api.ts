import type {
  AssignableUser,
  CalendarEventItem,
  ConversationItem,
  ConversationState,
  DashboardSummary,
  FollowUpItem,
  LeadItem,
  MessageDirection,
  MessageItem,
  MessageSenderType,
  PipelineView,
} from '../api/types';

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
/** Fake sign-in identity for demo mode — the local-part becomes the displayed name/avatar (see lib/auth/identity.ts). */
export const DEMO_USER_EMAIL = 'edson@exemplo.test';
const KEY = 'inovasix-demo-v1';
const SESSION = 'inovasix-demo-session';
const stages = ['Novo lead', 'Contato realizado', 'Em atendimento', 'Qualificado', 'Proposta enviada', 'Negociação', 'Cliente (Ganho)'].map((name, position) => ({ id: `stage-${position}`, name, position }));
const pipelines: PipelineView[] = [{ id: 'demo-pipeline', name: 'Comercial', isDefault: true, stages }];
interface State { leads: LeadItem[]; followups: FollowUpItem[]; events: CalendarEventItem[] }
let memory: State | undefined;
function date(day: number, hour = 14) { const d = new Date(); d.setDate(d.getDate() + day); d.setHours(hour, 0, 0, 0); return d.toISOString(); }
function initial(): State {
  const names = ['Maria Silva', 'Rafael Nunes', 'João Oliveira', 'Ana Costa', 'Carlos Mendes', 'Paulo Lima', 'Mariana Souza'];
  const leads: LeadItem[] = names.map((name, i) => ({ id: `lead-${i}`, name, company: ['Silva & Cia', 'Nunes Odonto', 'Oliveira Log', 'Costa Imóveis', 'Mendes Engenharia', 'Lima Distribuidora', 'Souza Advocacia'][i], email: `contato${i}@exemplo.test`, phone: null, amountCents: (i + 1) * 120000, status: i === 6 ? 'WON' : 'OPEN', stageId: stages[i].id, stageName: stages[i].name, ownerName: 'Equipe Demo', source: 'Demonstração', interest: 'Solução comercial', lastInteractionAt: date(0, 9), nextActionAt: date(0, 15), createdAt: date(-i) }));
  const followups: FollowUpItem[] = leads.slice(0, 3).map((l, i) => ({ id: `followup-${i}`, leadId: l.id, leadName: l.name, leadCompany: l.company, ownerUserId: 'demo-user', ownerName: 'Equipe Demo', title: ['Retornar contato', 'Apresentar proposta', 'Confirmar reunião'][i], description: 'Atividade fictícia para demonstração.', type: 'CALL', priority: 'MEDIUM', status: 'PENDING', scheduledAt: date(i === 0 ? -1 : 0, 14 + i), completedAt: null, canceledAt: null, overdue: false, createdAt: date(-2), updatedAt: date(0) }));
  const events: CalendarEventItem[] = leads.slice(0, 3).map((l, i) => ({ id: `event-${i}`, leadId: l.id, leadName: l.name, ownerUserId: 'demo-user', ownerName: 'Equipe Demo', title: `Apresentação — ${l.company}`, description: 'Reunião simulada. Nenhum convite será enviado.', type: 'MEETING', status: 'SCHEDULED', startsAt: date(0, 10 + i * 2), endsAt: date(0, 11 + i * 2), createdAt: date(-1), updatedAt: date(0) }));
  return { leads, followups, events };
}
function state(): State {
  if (memory) return memory;
  try { const raw = sessionStorage.getItem(KEY); if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed.leads) && Array.isArray(parsed.followups) && Array.isArray(parsed.events)) memory = parsed; } } catch { /* Storage unavailable: in-memory demo. */ }
  return memory ??= initial();
}
function save() { try { sessionStorage.setItem(KEY, JSON.stringify(state())); } catch { /* In-memory fallback. */ } }
export function resetDemo() { memory = initial(); save(); inboxReset(); window.location.reload(); }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function signedOut() { try { return sessionStorage.getItem(SESSION) === 'out'; } catch { return false; } }
function session(value: string) { try { sessionStorage.setItem(SESSION, value); } catch { /* Optional. */ } }
/** Mirrors the real API's funnel math (dashboard.service.ts): percent is relative to the top-of-funnel stage, rounded to a whole number, so an intermediate stage never misreads as 100%. */
function funnelStages(leads: LeadItem[]) {
  const first = leads.filter(l => l.stageId === stages[0].id).length;
  return stages.map(stage => {
    const count = leads.filter(l => l.stageId === stage.id).length;
    return { id: stage.id, label: stage.name, count, percent: first > 0 ? Math.round(count / first * 100) : 0 };
  });
}
function summary(s: State): DashboardSummary {
  const today = (value: string) => new Date(value).toDateString() === new Date().toDateString();
  const won = s.leads.filter(l => l.status === 'WON');
  return { metrics: { newLeads: s.leads.filter(l => today(l.createdAt)).length, pipelineValue: s.leads.filter(l => l.status === 'OPEN').reduce((a, l) => a + (l.amountCents ?? 0), 0), scheduledMeetings: s.events.filter(e => e.status === 'SCHEDULED').length, monthlySales: won.reduce((a, l) => a + (l.amountCents ?? 0), 0), conversionRate: s.leads.length ? Math.round(won.length / s.leads.length * 100) : 0 }, funnel: funnelStages(s.leads), followUpsToday: s.followups.filter(f => f.status === 'PENDING' && today(f.scheduledAt)).map(f => ({ id: f.id, name: f.leadName, company: f.leadCompany, time: new Date(f.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), reason: f.title })), agendaToday: s.events.filter(e => e.status === 'SCHEDULED' && today(e.startsAt)).map(e => ({ id: e.id, name: e.title, time: new Date(e.startsAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) })), recentActivity: s.leads.slice(-5).reverse().map(l => ({ id: l.id, action: l.status === 'WON' ? 'LEAD_STAGE_CHANGED' : 'LEAD_CREATED', entity: l.name, entityId: l.id, time: l.lastInteractionAt })) };
}
// -- Inbox (Conversations/Messages) -------------------------------------------
//
// Persisted separately from the CRM `State` above, in localStorage (not
// sessionStorage) under its own versioned key, per the DEMO requirement that
// Inbox actions survive a reload. Guarded for SSR/tests: `typeof window`
// check first (no-op under Jest's node testEnvironment or during any SSR
// pass), then try/catch for a real browser that blocks/corrupts storage.

const INBOX_KEY = 'inovasix6-demo-inbox-v1';

interface InboxState {
  conversations: ConversationItem[];
  messages: Record<string, MessageItem[]>;
}

/** Colleagues eligible as "Atendente responsável". `demo-user` is the signed-in identity (see DEMO_USER_EMAIL / GET /api/auth/me), so assigning to it is what makes "Assumir atendimento" work. */
const ASSIGNABLE_USERS: AssignableUser[] = [
  { id: 'demo-user', name: 'Edson Ribeiro', email: 'edson@exemplo.test', status: 'ACTIVE', roleCodes: ['ADMIN'] },
  { id: 'demo-agent-bruna', name: 'Bruna Martins', email: 'bruna@exemplo.test', status: 'ACTIVE', roleCodes: ['GESTOR'] },
  { id: 'demo-agent-lucas', name: 'Lucas Prado', email: 'lucas@exemplo.test', status: 'ACTIVE', roleCodes: ['COMERCIAL'] },
];

/** Mirrors ConversationsService.ALLOWED_TRANSITIONS (apps/api) exactly — see also InboxView.tsx's own copy for the UI-facing rationale. */
const INBOX_STATE_TRANSITIONS: Partial<Record<ConversationState, ConversationState[]>> = {
  AI_ATENDENDO: ['AGUARDANDO_HUMANO', 'ENCERRADA'],
  AGUARDANDO_HUMANO: ['ENCERRADA'],
  HUMANO_ATENDENDO: ['ENCERRADA'],
  ENCERRADA: ['AGUARDANDO_HUMANO'],
};

/** Small artificial delay so Inbox loaders/spinners read as real network activity — skipped under test so the suite stays fast. */
const INBOX_LATENCY_MS = process.env.NODE_ENV === 'test' ? 0 : 150;
function delay(): Promise<void> {
  return INBOX_LATENCY_MS > 0 ? new Promise((resolve) => setTimeout(resolve, INBOX_LATENCY_MS)) : Promise.resolve();
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

function msg(
  conversationId: string,
  n: number,
  direction: MessageDirection,
  senderType: MessageSenderType,
  senderUserId: string | null,
  senderUserName: string | null,
  body: string,
  createdAt: string,
): MessageItem {
  return { id: `demo-msg-${conversationId}-${n}`, conversationId, direction, status: 'SENT', senderType, senderUserId, senderUserName, body, externalId: null, createdAt };
}

/** Fictional inbox: WhatsApp/Webchat/Instagram/Manual, one per ConversationState, with coherent customer/AI/human/system histories. */
function inboxInitial(): InboxState {
  const conv1: ConversationItem = {
    id: 'demo-conv-1', contactId: 'demo-contact-1', contactName: 'Beatriz Andrade', contactPhone: '+5511987650001', contactEmail: 'beatriz@exemplo.test', leadId: null,
    state: 'AI_ATENDENDO', channel: 'WHATSAPP', subject: 'Orçamento — atendimento 24/7', assignedUserId: null, assignedUserName: null,
    lastMessageAt: minutesAgo(17), createdAt: minutesAgo(20), updatedAt: minutesAgo(17),
  };
  const conv2: ConversationItem = {
    id: 'demo-conv-2', contactId: 'demo-contact-2', contactName: 'Rodrigo Teixeira', contactPhone: '+5511987650002', contactEmail: 'rodrigo@exemplo.test', leadId: null,
    state: 'AGUARDANDO_HUMANO', channel: 'WEBCHAT', subject: 'Pedido em atraso', assignedUserId: null, assignedUserName: null,
    lastMessageAt: minutesAgo(40), createdAt: minutesAgo(45), updatedAt: minutesAgo(40),
  };
  const conv3: ConversationItem = {
    id: 'demo-conv-3', contactId: 'demo-contact-3', contactName: 'Camila Duarte', contactPhone: '+5511987650003', contactEmail: 'camila@exemplo.test', leadId: null,
    state: 'HUMANO_ATENDENDO', channel: 'INSTAGRAM', subject: 'Dúvida sobre planos', assignedUserId: 'demo-agent-bruna', assignedUserName: 'Bruna Martins',
    lastMessageAt: hoursAgo(2.75), createdAt: hoursAgo(3), updatedAt: hoursAgo(2.75),
  };
  const conv4: ConversationItem = {
    id: 'demo-conv-4', contactId: 'demo-contact-4', contactName: 'Eduardo Farias', contactPhone: '+5511987650004', contactEmail: 'eduardo@exemplo.test', leadId: null,
    state: 'ENCERRADA', channel: 'MANUAL', subject: 'Dúvida sobre contrato — resolvida', assignedUserId: 'demo-user', assignedUserName: 'Edson Ribeiro',
    lastMessageAt: hoursAgo(25.65), createdAt: hoursAgo(26), updatedAt: hoursAgo(25.65),
  };

  const messages: Record<string, MessageItem[]> = {
    [conv1.id]: [
      msg(conv1.id, 1, 'INBOUND', 'CUSTOMER', null, null, 'Oi, vocês fazem atendimento pelo WhatsApp integrado com IA?', minutesAgo(20)),
      msg(conv1.id, 2, 'OUTBOUND', 'AI', null, null, 'Olá, Beatriz! Sim, nossa IA atende 24 horas por dia e transfere para um humano quando necessário. Posso te enviar os planos disponíveis?', minutesAgo(19)),
      msg(conv1.id, 3, 'INBOUND', 'CUSTOMER', null, null, 'Pode sim, por favor.', minutesAgo(17)),
    ],
    [conv2.id]: [
      msg(conv2.id, 1, 'INBOUND', 'CUSTOMER', null, null, 'Preciso de ajuda com um pedido em atraso.', minutesAgo(45)),
      msg(conv2.id, 2, 'OUTBOUND', 'AI', null, null, 'Olá, Rodrigo! Posso verificar isso para você. Só um instante.', minutesAgo(44)),
      msg(conv2.id, 3, 'INBOUND', 'CUSTOMER', null, null, 'Na verdade prefiro falar com uma pessoa, é urgente.', minutesAgo(41)),
      msg(conv2.id, 4, 'OUTBOUND', 'SYSTEM', null, null, 'Conversa encaminhada para atendimento humano.', minutesAgo(40)),
    ],
    [conv3.id]: [
      msg(conv3.id, 1, 'INBOUND', 'CUSTOMER', null, null, 'Vi o anúncio de vocês no Instagram, quero saber mais sobre os planos.', hoursAgo(3)),
      msg(conv3.id, 2, 'OUTBOUND', 'AI', null, null, 'Oi, Camila! Temos planos a partir de R$ 297/mês. Vou te transferir para uma especialista.', hoursAgo(2.92)),
      msg(conv3.id, 3, 'OUTBOUND', 'AGENT', 'demo-agent-bruna', 'Bruna Martins', 'Oi, Camila! Aqui é a Bruna. Posso te mostrar uma demonstração ainda hoje?', hoursAgo(2.83)),
      msg(conv3.id, 4, 'INBOUND', 'CUSTOMER', null, null, 'Perfeito, pode ser às 16h?', hoursAgo(2.75)),
    ],
    [conv4.id]: [
      msg(conv4.id, 1, 'INBOUND', 'CUSTOMER', null, null, 'Bom dia, gostaria de tirar uma dúvida sobre o contrato.', hoursAgo(26)),
      msg(conv4.id, 2, 'OUTBOUND', 'AGENT', 'demo-user', 'Edson Ribeiro', 'Bom dia, Eduardo! Claro, qual é a dúvida?', hoursAgo(25.83)),
      msg(conv4.id, 3, 'INBOUND', 'CUSTOMER', null, null, 'Já resolvi, obrigado!', hoursAgo(25.7)),
      msg(conv4.id, 4, 'OUTBOUND', 'SYSTEM', null, null, 'Conversa encerrada por Edson Ribeiro.', hoursAgo(25.65)),
    ],
  };

  return { conversations: [conv1, conv2, conv3, conv4], messages };
}

let inboxMemory: InboxState | undefined;

function loadInboxState(): InboxState | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(INBOX_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.conversations) && parsed.messages && typeof parsed.messages === 'object') {
      return parsed as InboxState;
    }
  } catch {
    // Corrupted JSON or storage unavailable (private mode, quota, SSR): fall back to fixtures.
  }
  return undefined;
}

function inboxState(): InboxState {
  return (inboxMemory ??= loadInboxState() ?? inboxInitial());
}

function inboxSave(inbox: InboxState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(INBOX_KEY, JSON.stringify(inbox));
  } catch {
    // Storage unavailable: in-memory only for the rest of this session.
  }
}

function inboxReset(): void {
  inboxMemory = inboxInitial();
  inboxSave(inboxMemory);
}

function listConversationsFor(inbox: InboxState, q: URLSearchParams) {
  const state = q.get('state');
  const channel = q.get('channel');
  const unassigned = q.get('unassigned') === 'true';
  const assignedUserId = q.get('assignedUserId');
  const term = q.get('search')?.toLocaleLowerCase();
  const filtered = inbox.conversations.filter((c) => {
    if (state && c.state !== state) return false;
    if (channel && c.channel !== channel) return false;
    if (unassigned) {
      if (c.assignedUserId !== null) return false;
    } else if (assignedUserId && c.assignedUserId !== assignedUserId) {
      return false;
    }
    if (term && ![c.contactName, c.contactPhone, c.contactEmail].some((v) => String(v ?? '').toLocaleLowerCase().includes(term))) {
      return false;
    }
    return true;
  });
  const sorted = filtered.slice().sort((a, b) => {
    if (a.lastMessageAt !== b.lastMessageAt) {
      if (a.lastMessageAt === null) return 1;
      if (b.lastMessageAt === null) return -1;
      return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
  const page = Math.max(1, Number(q.get('page')) || 1);
  const pageSize = Math.max(1, Number(q.get('pageSize')) || 20);
  return { items: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pageSize };
}

/** Keyset pagination mirroring MessagesService.list: chronological items, `before` walks further back. */
function listMessagesFor(inbox: InboxState, conversationId: string, limit: number, before?: string) {
  const all = (inbox.messages[conversationId] ?? []).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  let pool = all;
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    pool = idx >= 0 ? all.slice(0, idx) : all;
  }
  const hasMore = pool.length > limit;
  const items = hasMore ? pool.slice(pool.length - limit) : pool;
  const nextCursor = hasMore ? items[0].id : null;
  return { items, nextCursor, hasMore };
}

/**
 * Handles every /api/conversations* and /api/users/assignable route. Returns
 * `null` for anything else so `demoRequest` falls through to the existing
 * leads/follow-ups/calendar dispatch below.
 */
async function handleInboxRoute(p: string, q: URLSearchParams, method: string, init: RequestInit): Promise<Response | null> {
  if (p === '/api/users/assignable') {
    await delay();
    return response(ASSIGNABLE_USERS);
  }

  if (p === '/api/conversations') {
    if (method !== 'GET') return response({ message: 'Ação não disponível.' }, 405);
    await delay();
    return response(listConversationsFor(inboxState(), q));
  }

  const convMatch = p.match(/^\/api\/conversations\/([^/]+)(?:\/(state|assign|unassign|messages))?$/);
  if (!convMatch) return null;

  await delay();
  const [, id, action] = convMatch;
  const inbox = inboxState();
  const conversation = inbox.conversations.find((c) => c.id === id);
  if (!conversation) return response({ message: 'Conversa não encontrada.' }, 404);

  if (!action) {
    if (method !== 'GET') return response({ message: 'Ação não disponível.' }, 405);
    return response(conversation);
  }

  if (action === 'messages') {
    if (method === 'GET') {
      const limit = Math.max(1, Number(q.get('limit')) || 50);
      return response(listMessagesFor(inbox, id, limit, q.get('before') ?? undefined));
    }
    if (method === 'POST') {
      if (conversation.state === 'ENCERRADA') {
        return response({ message: 'Não é possível enviar mensagem em uma conversa encerrada. Reabra antes de responder.' }, 409);
      }
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      const now = new Date().toISOString();
      const list = (inbox.messages[id] ??= []);
      const message = msg(id, list.length + 1, 'OUTBOUND', 'AGENT', 'demo-user', 'Edson Ribeiro', String(body.body ?? ''), now);
      list.push(message);
      conversation.lastMessageAt = now;
      conversation.updatedAt = now;
      inboxSave(inbox);
      return response(message, 201);
    }
    return response({ message: 'Ação não disponível.' }, 405);
  }

  if (method !== 'PATCH') return response({ message: 'Ação não disponível.' }, 405);
  const now = new Date().toISOString();

  if (action === 'state') {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const target = body.state as ConversationState;
    if (conversation.state === target) return response(conversation);
    const allowed = INBOX_STATE_TRANSITIONS[conversation.state] ?? [];
    if (!allowed.includes(target)) {
      return response({ message: `Transição de ${conversation.state} para ${target} não é permitida.` }, 409);
    }
    conversation.state = target;
    conversation.updatedAt = now;
    inboxSave(inbox);
    return response(conversation);
  }

  if (action === 'assign') {
    if (conversation.state === 'ENCERRADA') {
      return response({ message: 'Conversa encerrada não pode ser atribuída. Reabra antes de atribuir.' }, 409);
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const agent = ASSIGNABLE_USERS.find((a) => a.id === body.userId);
    if (!agent) return response({ message: 'Usuário inválido para este tenant.' }, 400);
    conversation.assignedUserId = agent.id;
    conversation.assignedUserName = agent.name;
    conversation.state = 'HUMANO_ATENDENDO';
    conversation.updatedAt = now;
    inboxSave(inbox);
    return response(conversation);
  }

  // action === 'unassign'
  if (conversation.assignedUserId === null) return response(conversation);
  conversation.assignedUserId = null;
  conversation.assignedUserName = null;
  if (conversation.state === 'HUMANO_ATENDENDO') conversation.state = 'AGUARDANDO_HUMANO';
  conversation.updatedAt = now;
  inboxSave(inbox);
  return response(conversation);
}

export async function demoRequest(path: string, init: RequestInit): Promise<Response> {
  const url = new URL(path, 'https://demo.invalid'); const p = url.pathname; const q = url.searchParams;
  const method = init.method ?? 'GET';
  const token = { accessToken: 'demo-only-not-a-real-token', expiresIn: 3600, tokenType: 'Bearer' };
  if (p === '/api/auth/logout') { session('out'); return response({}); }
  if (p === '/api/auth/login') { session('in'); return response(token); }
  if (p.startsWith('/api/auth/') && signedOut()) return response({ message: 'Entre na demonstração.' }, 401);
  if (p === '/api/auth/refresh') return response(token);
  if (p === '/api/auth/me') return response({ userId: 'demo-user', tenantId: 'demo-tenant', roles: ['ADMIN'] });
  const s = state();
  s.followups.forEach(f => { f.overdue = f.status === 'PENDING' && new Date(f.scheduledAt).getTime() < Date.now(); });
  if (p === '/api/dashboard/summary') return response(summary(s));
  if (p === '/api/pipelines') return response(pipelines);
  const inboxResponse = await handleInboxRoute(p, q, method, init);
  if (inboxResponse) return inboxResponse;
  const match = p.match(/^\/api\/(leads|follow-ups|calendar\/events)(?:\/([^/]+))?(?:\/(stage|complete|cancel|reschedule))?$/);
  if (!match) return response({ message: 'Recurso não disponível na demonstração.' }, 404);
  const [, resource, id, action] = match;
  const collection = resource === 'leads' ? s.leads : resource === 'follow-ups' ? s.followups : s.events;
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  if (method === 'GET') {
    if (id) { const item = collection.find(x => x.id === id); return response(item ?? { message: 'Registro não encontrado.' }, item ? 200 : 404); }
    const items = collection.filter(item => {
      const x = item as unknown as Record<string, unknown>;
      const overdue = q.get('overdue') === 'true';
      for (const key of ['status', 'stageId', 'leadId', 'ownerUserId']) if (!(overdue && key === 'status') && q.has(key) && x[key] !== q.get(key)) return false;
      if (overdue && !x.overdue) return false;
      const term = q.get('search')?.toLocaleLowerCase(); if (term && ![x.name, x.company, x.email].some(v => String(v ?? '').toLocaleLowerCase().includes(term))) return false;
      const when = String(x.scheduledAt ?? x.startsAt ?? x.createdAt);
      if (!overdue && q.has('from') && new Date(when) < new Date(q.get('from')!)) return false;
      if (!overdue && q.has('to') && new Date(when) > new Date(q.get('to')!)) return false;
      return true;
    });
    const page = Math.max(1, Number(q.get('page')) || 1); const pageSize = Math.max(1, Number(q.get('pageSize')) || 20);
    return response({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize });
  }
  const now = new Date().toISOString();
  if (method === 'POST' && !id) {
    const lead = s.leads.find(l => l.id === body.leadId); const newId = crypto.randomUUID();
    if (resource === 'leads') {
      const stage = stages.find(x => x.id === body.stageId) ?? stages[0];
      s.leads.push({ id: newId, name: body.name, company: body.company ?? null, email: body.email ?? null, phone: body.phone ?? null, amountCents: body.amountCents ?? 0, status: stage.position === 6 ? 'WON' : 'OPEN', stageId: stage.id, stageName: stage.name, ownerName: 'Equipe Demo', source: body.source ?? 'Demo', interest: body.interest ?? null, lastInteractionAt: now, nextActionAt: null, createdAt: now });
    } else if (resource === 'follow-ups') {
      if (!lead) return response({ message: 'Selecione um lead.' }, 400);
      s.followups.push({ ...body, id: newId, leadId: lead.id, leadName: lead.name, leadCompany: lead.company, ownerUserId: 'demo-user', ownerName: 'Equipe Demo', title: body.title, description: body.description ?? null, type: body.type ?? 'CALL', priority: body.priority ?? 'MEDIUM', status: 'PENDING', scheduledAt: body.scheduledAt, completedAt: null, canceledAt: null, overdue: false, createdAt: now, updatedAt: now });
    } else {
      s.events.push({ ...body, id: newId, leadId: lead?.id ?? null, leadName: lead?.name ?? null, ownerUserId: 'demo-user', ownerName: 'Equipe Demo', title: body.title, description: body.description ?? null, type: body.type ?? 'MEETING', status: 'SCHEDULED', startsAt: body.startsAt, endsAt: body.endsAt ?? null, createdAt: now, updatedAt: now });
    }
    save(); return response(collection.find(x => x.id === newId), 201);
  }
  const item = collection.find(x => x.id === id);
  if (!item) return response({ message: 'Registro não encontrado.' }, 404);
  if (method !== 'PATCH') return response({ message: 'Ação não disponível.' }, 405);
  if (resource === 'leads') {
    const stage = stages.find(x => x.id === body.stageId); if (!stage) return response({ message: 'Etapa inválida.' }, 400);
    Object.assign(item, { stageId: stage.id, stageName: stage.name, status: stage.position === 6 ? 'WON' : 'OPEN', lastInteractionAt: now });
  } else {
    const active = resource === 'follow-ups' ? 'PENDING' : 'SCHEDULED';
    if (item.status !== active) return response({ message: 'Este registro já foi concluído ou cancelado.' }, 409);
    if (action === 'complete' || action === 'cancel') Object.assign(item, { status: action === 'complete' ? 'COMPLETED' : 'CANCELED', [action === 'complete' ? 'completedAt' : 'canceledAt']: now });
    else Object.assign(item, body);
    if (body.leadId) { const lead = s.leads.find(l => l.id === body.leadId); if (lead) Object.assign(item, { leadName: lead.name, leadCompany: lead.company }); }
    Object.assign(item, { updatedAt: now });
  }
  save(); return response(item);
}
