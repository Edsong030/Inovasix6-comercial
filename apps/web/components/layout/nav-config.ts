import type { ComponentType } from 'react';
import {
  IconAgenda,
  IconCrm,
  IconDashboard,
  IconFollowups,
  IconInbox,
  IconKnowledge,
  IconLeads,
  IconSettings,
  IconTeam,
  type IconProps,
} from '@/components/ui/icons';

export interface NavItem {
  href: string;
  /** Sidebar label. */
  label: string;
  /** Topbar title — may differ from the compact sidebar label. */
  title: string;
  icon: ComponentType<IconProps>;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'principal',
    label: 'Principal',
    items: [
      { href: '/', label: 'Dashboard', title: 'Dashboard', icon: IconDashboard },
      { href: '/inbox', label: 'Inbox', title: 'Inbox', icon: IconInbox },
      { href: '/crm', label: 'CRM', title: 'CRM', icon: IconCrm },
      { href: '/leads', label: 'Leads', title: 'Leads', icon: IconLeads },
      { href: '/agenda', label: 'Agenda', title: 'Agenda', icon: IconAgenda },
    ],
  },
  {
    id: 'automacao',
    label: 'Automação',
    items: [
      { href: '/knowledge', label: 'Base de IA', title: 'Base de IA', icon: IconKnowledge },
      { href: '/followups', label: 'Follow-ups', title: 'Follow-ups', icon: IconFollowups },
    ],
  },
  {
    id: 'gestao',
    label: 'Gestão',
    items: [
      { href: '/team', label: 'Equipe', title: 'Equipe', icon: IconTeam },
      { href: '/settings', label: 'Configurações', title: 'Configurações', icon: IconSettings },
    ],
  },
];

const ALL_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/** Route → topbar title. Falls back to the product name for unknown paths. */
export function titleForPath(pathname: string): string {
  const match = ALL_ITEMS.find((item) =>
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href),
  );
  return match?.title ?? 'Inovasix6 Comercial IA';
}

/** True when the nav item should be marked `aria-current="page"`. */
export function isActivePath(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
