import type { CreateLeadInput, LeadItem } from '@/lib/api/types';

/**
 * Pure logic shared by the in-flow "Cadastrar novo cliente" experience of the
 * meeting (CalendarEventDrawer) and follow-up (FollowUpDrawer) drawers.
 *
 * Kept framework-free so it can be unit-tested under the web app's node/jest
 * harness (no React rendering / no new test dependency), while the drawers
 * consume exactly this logic — the tests therefore exercise the real code
 * paths, not a re-implementation.
 */

/** Sentinel option value for the "+ Cadastrar novo cliente" entry in a Lead select. */
export const NEW_LEAD_OPTION = '__new__';

/** True when the Lead select value corresponds to the "+ Cadastrar novo cliente" action. */
export function isNewLeadOption(value: string): boolean {
  return value === NEW_LEAD_OPTION;
}

/**
 * Prepend a freshly created lead to the current list, de-duplicating by id so
 * a double callback never inserts it twice. Returns a NEW array (never mutates
 * the input) so React state updates stay predictable.
 */
export function mergeCreatedLead(current: LeadItem[], created: LeadItem): LeadItem[] {
  if (current.some((l) => l.id === created.id)) return current;
  return [created, ...current];
}

/**
 * Merge a form object with the selection of a newly created lead. Every OTHER
 * field the user already typed is preserved untouched — only `leadId` changes.
 * This is the guarantee that the main form's data is never lost when a client
 * is registered mid-flow.
 */
export function selectCreatedLead<T extends { leadId: string }>(form: T, created: LeadItem): T {
  return { ...form, leadId: created.id };
}

/** Human-readable success feedback shown after an in-flow lead creation. */
export function createdLeadNotice(created: LeadItem): string {
  return `Cliente "${created.name}" cadastrado e selecionado.`;
}

export interface LeadSelectOption {
  value: string;
  label: string;
}

/**
 * Options for the "Cliente / Lead" select, AFTER the neutral placeholder
 * ("Nenhum" / "Selecione…", which differs by drawer and stays hardcoded
 * there). "+ Cadastrar novo cliente" is always first here — immediately
 * after the placeholder — so a growing lead list never pushes the create
 * action further down the list. Shared by CalendarEventDrawer and
 * FollowUpDrawer so both stay in sync by construction, not by convention.
 */
export function buildLeadSelectOptions(leads: LeadItem[]): LeadSelectOption[] {
  return [
    { value: NEW_LEAD_OPTION, label: '+ Cadastrar novo cliente' },
    ...leads.map((lead) => ({
      value: lead.id,
      label: lead.company ? `${lead.name} — ${lead.company}` : lead.interest ? `${lead.name} — ${lead.interest}` : lead.name,
    })),
  ];
}

/** Raw quick-lead form fields (all strings, as held in the drawer state). */
export interface QuickLeadFormValues {
  name: string;
  company: string;
  email: string;
  phone: string;
}

/**
 * Build the CreateLeadInput for the SAME POST /api/leads used everywhere else.
 * Only `name` is required (per the backend CreateLeadDto); empty optional
 * fields are dropped so we never send blank strings. tenantId is never part of
 * the payload — the server derives it from the authenticated token. Returns
 * null when the required name is blank, so the caller can show a message and
 * NOT create a partial record.
 */
export function buildQuickLeadInput(
  values: QuickLeadFormValues,
  stageId?: string,
): CreateLeadInput | null {
  const name = values.name.trim();
  if (!name) return null;
  return {
    name,
    company: values.company.trim() || undefined,
    email: values.email.trim() || undefined,
    phone: values.phone.trim() || undefined,
    stageId: stageId || undefined,
  };
}
