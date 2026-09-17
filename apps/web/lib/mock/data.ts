/**
 * MOCK DATA — placeholder content for the visual homologation build.
 *
 * Everything in this file is hard-coded. Only Knowledge (Base de IA) and Team
 * still read from here — every other screen that used to (dashboard, CRM,
 * leads, agenda, follow-ups and now the Inbox/conversations) has since moved
 * to the real API. The unused dashboard/CRM/leads exports below were left in
 * place rather than removed as dead code in this change, since that cleanup
 * is unrelated to the Inbox work this file was touched for.
 */

import type { BadgeTone } from '@/components/ui/Badge';

// -- Dashboard ---------------------------------------------------------------

export interface Metric {
  id: string;
  label: string;
  value: string;
  delta: string;
  trend: 'up' | 'down' | 'flat';
  hint: string;
}

/** Icon+tone key rendered by the KPI grid, mapped in the component. */
export type MetricAccent = 'blue' | 'cyan' | 'violet' | 'magenta';

export interface Metric {
  id: string;
  label: string;
  value: string;
  delta: string;
  trend: 'up' | 'down' | 'flat';
  hint: string;
  accent: MetricAccent;
}

export const DASHBOARD_METRICS: Metric[] = [
  {
    id: 'new-leads',
    label: 'Novos leads',
    value: '352',
    delta: '+28%',
    trend: 'up',
    hint: 'vs. ontem',
    accent: 'blue',
  },
  {
    id: 'opportunities',
    label: 'Em oportunidades',
    value: 'R$ 124.800',
    delta: '+16%',
    trend: 'up',
    hint: 'vs. ontem',
    accent: 'cyan',
  },
  {
    id: 'meetings',
    label: 'Reuniões agendadas',
    value: '67',
    delta: '+32%',
    trend: 'up',
    hint: 'vs. semana',
    accent: 'violet',
  },
  {
    id: 'sales',
    label: 'Vendas no mês',
    value: '29',
    delta: '+24%',
    trend: 'up',
    hint: 'vs. mês passado',
    accent: 'magenta',
  },
];

/** Headline summary shown under the greeting; numbers are colour-coded. */
export const DASHBOARD_SUMMARY = {
  leads: 32,
  followups: 8,
  meetings: 3,
};

export interface FunnelStage {
  id: string;
  label: string;
  count: number;
  percent: number;
}

export const FUNNEL_STAGES: FunnelStage[] = [
  { id: 'new', label: 'Novo lead', count: 352, percent: 100 },
  { id: 'contacted', label: 'Contato realizado', count: 268, percent: 76 },
  { id: 'in-service', label: 'Em atendimento', count: 192, percent: 55 },
  { id: 'proposal', label: 'Proposta enviada', count: 104, percent: 30 },
  { id: 'negotiation', label: 'Negociação', count: 63, percent: 18 },
  { id: 'won', label: 'Cliente (Ganho)', count: 29, percent: 8 },
];

/** Conversion donut + opportunities value on the funnel card. */
export const FUNNEL_CONVERSION = {
  rate: 8,
  deltaLabel: '+2,4% vs mês anterior',
  opportunities: 'R$ 124.800',
};

export type ActivityType = 'atendimento' | 'lead' | 'agenda' | 'proposta' | 'negociacao';

export interface ActivityEntry {
  id: string;
  title: string;
  detail: string;
  time: string;
  type: ActivityType;
}

export const RECENT_ACTIVITY: ActivityEntry[] = [
  {
    id: 'a1',
    title: 'Carla Mendes respondeu seu e-mail',
    detail: 'Interesse em demonstração',
    time: 'há 12 min',
    type: 'atendimento',
  },
  {
    id: 'a2',
    title: 'Novo lead de site',
    detail: 'Lucas Pereira · Tech Solutions',
    time: 'há 28 min',
    type: 'lead',
  },
  {
    id: 'a3',
    title: 'Reunião agendada',
    detail: 'Ana Costa · Solutions LTDA',
    time: 'há 1 h',
    type: 'agenda',
  },
  {
    id: 'a4',
    title: 'Proposta visualizada',
    detail: 'Empresa Alfa',
    time: 'há 2 h',
    type: 'proposta',
  },
  {
    id: 'a5',
    title: 'Negociação atualizada',
    detail: 'TechCorp · Etapa: Proposta',
    time: 'há 3 h',
    type: 'negociacao',
  },
];

// -- CRM ---------------------------------------------------------------------

export interface CrmCard {
  id: string;
  name: string;
  company: string;
  value: string;
  owner: string;
  age: string;
  channel: string;
}

export interface CrmColumn {
  id: string;
  label: string;
  tone: BadgeTone;
  cards: CrmCard[];
}

export const CRM_COLUMNS: CrmColumn[] = [
  {
    id: 'new',
    label: 'Novo Lead',
    tone: 'neutral',
    cards: [
      {
        id: 'k1',
        name: 'Maria Silva',
        company: 'Silva & Cia',
        value: 'R$ 2.400/mês',
        owner: 'Edson',
        age: 'Hoje',
        channel: 'WhatsApp',
      },
      {
        id: 'k2',
        name: 'Rafael Nunes',
        company: 'Nunes Odonto',
        value: 'R$ 1.200/mês',
        owner: 'Bruna',
        age: 'Hoje',
        channel: 'WhatsApp',
      },
      {
        id: 'k3',
        name: 'Tatiana Reis',
        company: 'Studio TR',
        value: 'R$ 900/mês',
        owner: 'Não atribuído',
        age: '1 dia',
        channel: 'Instagram',
      },
    ],
  },
  {
    id: 'in-service',
    label: 'Em Atendimento',
    tone: 'info',
    cards: [
      {
        id: 'k4',
        name: 'João Oliveira',
        company: 'Oliveira Log',
        value: 'R$ 3.100/mês',
        owner: 'Edson',
        age: '2 dias',
        channel: 'WhatsApp',
      },
      {
        id: 'k5',
        name: 'Fernanda Dias',
        company: 'FD Contabilidade',
        value: 'R$ 1.800/mês',
        owner: 'Bruna',
        age: '2 dias',
        channel: 'Site',
      },
    ],
  },
  {
    id: 'qualified',
    label: 'Qualificado',
    tone: 'accent',
    cards: [
      {
        id: 'k6',
        name: 'Ana Costa',
        company: 'Costa Imóveis',
        value: 'R$ 4.500/mês',
        owner: 'Edson',
        age: '4 dias',
        channel: 'WhatsApp',
      },
      {
        id: 'k7',
        name: 'Pedro Almeida',
        company: 'Almeida Fit',
        value: 'R$ 1.500/mês',
        owner: 'Lucas',
        age: '5 dias',
        channel: 'Indicação',
      },
    ],
  },
  {
    id: 'proposal',
    label: 'Proposta',
    tone: 'warning',
    cards: [
      {
        id: 'k8',
        name: 'Carlos Mendes',
        company: 'Mendes Engenharia',
        value: 'R$ 6.200/mês',
        owner: 'Edson',
        age: '6 dias',
        channel: 'WhatsApp',
      },
    ],
  },
  {
    id: 'negotiation',
    label: 'Negociação',
    tone: 'warning',
    cards: [
      {
        id: 'k9',
        name: 'Paulo Lima',
        company: 'Lima Distribuidora',
        value: 'R$ 8.900/mês',
        owner: 'Bruna',
        age: '9 dias',
        channel: 'Indicação',
      },
    ],
  },
  {
    id: 'won',
    label: 'Ganho',
    tone: 'success',
    cards: [
      {
        id: 'k10',
        name: 'Mariana Souza',
        company: 'Souza Advocacia',
        value: 'R$ 3.700/mês',
        owner: 'Edson',
        age: '12 dias',
        channel: 'WhatsApp',
      },
    ],
  },
];

// -- Leads -------------------------------------------------------------------

export interface LeadRow {
  id: string;
  name: string;
  origin: string;
  interest: string;
  owner: string;
  status: string;
  statusTone: BadgeTone;
  lastInteraction: string;
  nextAction: string;
}

export const LEAD_ROWS: LeadRow[] = [
  {
    id: 'l1',
    name: 'Maria Silva',
    origin: 'WhatsApp',
    interest: 'Automação de atendimento',
    owner: 'Edson',
    status: 'Em Atendimento',
    statusTone: 'info',
    lastInteraction: 'Há 3 min',
    nextAction: 'Enviar proposta · hoje 17:00',
  },
  {
    id: 'l2',
    name: 'Carlos Mendes',
    origin: 'WhatsApp',
    interest: 'Plano Enterprise',
    owner: 'Edson',
    status: 'Proposta',
    statusTone: 'warning',
    lastInteraction: 'Há 2 h',
    nextAction: 'Follow-up · hoje 10:00',
  },
  {
    id: 'l3',
    name: 'Ana Costa',
    origin: 'WhatsApp',
    interest: 'Integração com CRM',
    owner: 'Bruna',
    status: 'Qualificado',
    statusTone: 'accent',
    lastInteraction: 'Ontem',
    nextAction: 'Apresentação · 15:30',
  },
  {
    id: 'l4',
    name: 'João Oliveira',
    origin: 'Site',
    interest: 'Atendimento 24/7',
    owner: 'Edson',
    status: 'Em Atendimento',
    statusTone: 'info',
    lastInteraction: 'Ontem',
    nextAction: 'Retomar contato · amanhã',
  },
  {
    id: 'l5',
    name: 'Mariana Souza',
    origin: 'Indicação',
    interest: 'Plano Pro',
    owner: 'Bruna',
    status: 'Ganho',
    statusTone: 'success',
    lastInteraction: 'Seg, 16:20',
    nextAction: 'Onboarding · quinta',
  },
  {
    id: 'l6',
    name: 'Rafael Nunes',
    origin: 'Instagram',
    interest: 'Agendamento automático',
    owner: 'Não atribuído',
    status: 'Novo Lead',
    statusTone: 'neutral',
    lastInteraction: 'Há 26 min',
    nextAction: 'Atribuir responsável',
  },
  {
    id: 'l7',
    name: 'Paulo Lima',
    origin: 'Indicação',
    interest: 'Multi-unidades',
    owner: 'Bruna',
    status: 'Negociação',
    statusTone: 'warning',
    lastInteraction: 'Há 1 dia',
    nextAction: 'Negociação · hoje 14:00',
  },
  {
    id: 'l8',
    name: 'Fernanda Dias',
    origin: 'Site',
    interest: 'Automação de follow-up',
    owner: 'Lucas',
    status: 'Perdido',
    statusTone: 'danger',
    lastInteraction: 'Sex, 11:05',
    nextAction: '—',
  },
];

export const LEAD_STATUS_FILTERS = [
  'Todos',
  'Novo Lead',
  'Em Atendimento',
  'Qualificado',
  'Proposta',
  'Negociação',
  'Ganho',
  'Perdido',
];

// -- Knowledge ---------------------------------------------------------------

export interface KnowledgeCard {
  id: string;
  title: string;
  description: string;
  stat: string;
  updatedAt: string;
  icon: 'building' | 'target' | 'help' | 'document';
}

export const KNOWLEDGE_CARDS: KnowledgeCard[] = [
  {
    id: 'kb1',
    title: 'Informações da empresa',
    description: 'Quem somos, diferenciais, políticas e tom de voz do atendimento.',
    stat: 'Perfil completo',
    updatedAt: 'Atualizado há 2 dias',
    icon: 'building',
  },
  {
    id: 'kb2',
    title: 'Produtos e serviços',
    description: 'Catálogo usado pela IA para responder escopo, planos e preços.',
    stat: '8 serviços cadastrados',
    updatedAt: 'Atualizado há 5 dias',
    icon: 'target',
  },
  {
    id: 'kb3',
    title: 'Perguntas frequentes',
    description: 'Respostas padronizadas para as dúvidas mais comuns dos leads.',
    stat: '12 FAQs',
    updatedAt: 'Atualizado ontem',
    icon: 'help',
  },
  {
    id: 'kb4',
    title: 'Documentos',
    description: 'Materiais e propostas indexados para consulta da IA.',
    stat: '3 documentos ativos',
    updatedAt: 'Atualizado há 1 semana',
    icon: 'document',
  },
];

// -- Team --------------------------------------------------------------------

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  status: 'Ativo' | 'Convidado' | 'Suspenso';
  lastAccess: string;
  initials: string;
}

export const TEAM_MEMBERS: TeamMember[] = [
  {
    id: 't1',
    name: 'Edson Ribeiro',
    email: 'edson@demo.local',
    role: 'Administrador',
    status: 'Ativo',
    lastAccess: 'Agora',
    initials: 'ER',
  },
  {
    id: 't2',
    name: 'Bruna Martins',
    email: 'bruna@demo.local',
    role: 'Gestor',
    status: 'Ativo',
    lastAccess: 'Há 20 min',
    initials: 'BM',
  },
  {
    id: 't3',
    name: 'Lucas Prado',
    email: 'lucas@demo.local',
    role: 'Comercial',
    status: 'Ativo',
    lastAccess: 'Ontem',
    initials: 'LP',
  },
  {
    id: 't4',
    name: 'Camila Rocha',
    email: 'camila@demo.local',
    role: 'Atendente',
    status: 'Convidado',
    lastAccess: 'Nunca acessou',
    initials: 'CR',
  },
  {
    id: 't5',
    name: 'Diego Farias',
    email: 'diego@demo.local',
    role: 'Atendente',
    status: 'Suspenso',
    lastAccess: 'Há 3 semanas',
    initials: 'DF',
  },
];
