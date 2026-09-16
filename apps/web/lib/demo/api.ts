import type { LeadItem, FollowUpItem, CalendarEventItem, PipelineView, DashboardSummary } from '../api/types';

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
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
export function resetDemo() { memory = initial(); save(); window.location.reload(); }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function signedOut() { try { return sessionStorage.getItem(SESSION) === 'out'; } catch { return false; } }
function session(value: string) { try { sessionStorage.setItem(SESSION, value); } catch { /* Optional. */ } }
function summary(s: State): DashboardSummary {
  const today = (value: string) => new Date(value).toDateString() === new Date().toDateString();
  const won = s.leads.filter(l => l.status === 'WON');
  return { metrics: { newLeads: s.leads.filter(l => today(l.createdAt)).length, pipelineValue: s.leads.filter(l => l.status === 'OPEN').reduce((a, l) => a + (l.amountCents ?? 0), 0), scheduledMeetings: s.events.filter(e => e.status === 'SCHEDULED').length, monthlySales: won.reduce((a, l) => a + (l.amountCents ?? 0), 0), conversionRate: s.leads.length ? Math.round(won.length / s.leads.length * 100) : 0 }, funnel: stages.map(stage => { const count = s.leads.filter(l => l.stageId === stage.id).length; return { id: stage.id, label: stage.name, count, percent: s.leads.length ? count / s.leads.length * 100 : 0 }; }), followUpsToday: s.followups.filter(f => f.status === 'PENDING' && today(f.scheduledAt)).map(f => ({ id: f.id, name: f.leadName, company: f.leadCompany, time: new Date(f.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), reason: f.title })), agendaToday: s.events.filter(e => e.status === 'SCHEDULED' && today(e.startsAt)).map(e => ({ id: e.id, name: e.title, time: new Date(e.startsAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) })), recentActivity: s.leads.slice(-5).reverse().map(l => ({ id: l.id, action: 'Lead na demonstração', entity: l.name, entityId: l.id, time: l.lastInteractionAt })) };
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
