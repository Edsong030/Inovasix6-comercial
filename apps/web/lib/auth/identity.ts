import type { RoleCode } from './types';

/**
 * Display helpers.
 *
 * GET /api/auth/me returns only `userId`, `tenantId` and `roles`. There is no
 * profile endpoint yet, so the company/person labels shown in the shell are
 * DERIVED on the client from the slug and e-mail typed at login. When a real
 * profile endpoint exists these become a thin fallback.
 */

const ROLE_LABELS: Record<RoleCode, string> = {
  ADMIN: 'Administrador',
  GESTOR: 'Gestor',
  COMERCIAL: 'Comercial',
  ATENDENTE: 'Atendente',
};

/** Most-privileged first — the shell shows a single role label. */
const ROLE_RANK: RoleCode[] = ['ADMIN', 'GESTOR', 'COMERCIAL', 'ATENDENTE'];

export function roleLabel(roles: readonly RoleCode[]): string {
  const primary = ROLE_RANK.find((role) => roles.includes(role));
  return primary ? ROLE_LABELS[primary] : 'Usuário';
}

const capitalize = (word: string): string =>
  word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);

/** `inovasix-demo` → `Inovasix Demo`. */
export function companyNameFromSlug(slug: string): string {
  const name = slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ');
  return name || slug;
}

/** `edson@demo.local` → `Edson`; `ana.costa@x` → `Ana Costa`. */
export function displayNameFromEmail(email: string | null, fallback: string): string {
  const local = email?.split('@')[0]?.trim();
  if (!local) return fallback;
  const name = local
    .split(/[.\-_+]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ');
  return name || fallback;
}

export function initialsFrom(displayName: string): string {
  const parts = displayName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Greeting keyed to the local clock. */
export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}
