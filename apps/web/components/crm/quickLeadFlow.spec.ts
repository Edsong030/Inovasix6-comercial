import {
  NEW_LEAD_OPTION,
  buildLeadSelectOptions,
  buildQuickLeadInput,
  createdLeadNotice,
  isNewLeadOption,
  mergeCreatedLead,
  selectCreatedLead,
} from './quickLeadFlow';
import type { LeadItem } from '@/lib/api/types';

/**
 * Unit tests for the in-flow "Cadastrar novo cliente" logic shared by the
 * meeting (CalendarEventDrawer) and follow-up (FollowUpDrawer) drawers. These
 * cover the behaviours required by the business rule without React rendering
 * (the web harness is node-only, no @testing-library):
 *  - selecting an existing lead vs. the "+ Cadastrar novo cliente" action;
 *  - creating a new lead updates the list and auto-selects it;
 *  - the main form's other fields are preserved;
 *  - the quick-create input only sends necessary fields and reuses the same
 *    CreateLeadInput contract (no second creation rule, no client tenantId).
 */

function makeLead(overrides: Partial<LeadItem> = {}): LeadItem {
  return {
    id: 'lead-new',
    name: 'Maria Silva',
    company: 'Silva & Cia',
    email: null,
    phone: null,
    amountCents: null,
    status: 'OPEN',
    stageId: 'stage-1',
    stageName: 'Novo lead',
    ownerName: null,
    source: null,
    interest: 'Silva & Cia',
    lastInteractionAt: '2026-09-08T00:00:00.000Z',
    nextActionAt: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('lead select: existing vs. "+ Cadastrar novo cliente"', () => {
  it('detects the "novo cliente" sentinel', () => {
    expect(isNewLeadOption(NEW_LEAD_OPTION)).toBe(true);
  });

  it('treats a real lead id (or empty) as an existing selection, not the create action', () => {
    expect(isNewLeadOption('lead-123')).toBe(false);
    expect(isNewLeadOption('')).toBe(false);
  });
});

describe('buildLeadSelectOptions: "+ Cadastrar novo cliente" stays right after the placeholder', () => {
  it('puts the create action first, before any existing lead — even with a long list', () => {
    const leads = [
      makeLead({ id: 'lead-1', name: 'Maria Silva', company: 'Silva & Cia' }),
      makeLead({ id: 'lead-2', name: 'Rafael Nunes', company: 'Nunes Odonto' }),
      makeLead({ id: 'lead-3', name: 'João Oliveira', company: 'Oliveira Log' }),
    ];
    const options = buildLeadSelectOptions(leads);
    expect(options[0]).toEqual({ value: NEW_LEAD_OPTION, label: '+ Cadastrar novo cliente' });
  });

  it('lists the existing leads, in the given order, right after the create action', () => {
    const leads = [
      makeLead({ id: 'lead-1', name: 'Maria Silva', company: 'Silva & Cia' }),
      makeLead({ id: 'lead-2', name: 'Rafael Nunes', company: 'Nunes Odonto' }),
    ];
    const options = buildLeadSelectOptions(leads);
    expect(options.slice(1)).toEqual([
      { value: 'lead-1', label: 'Maria Silva — Silva & Cia' },
      { value: 'lead-2', label: 'Rafael Nunes — Nunes Odonto' },
    ]);
  });

  it('falls back to interest when there is no company, and to the bare name when there is neither', () => {
    const options = buildLeadSelectOptions([
      makeLead({ id: 'lead-1', name: 'Ana', company: null, interest: 'Automação' }),
      makeLead({ id: 'lead-2', name: 'Bruno', company: null, interest: null }),
    ]);
    expect(options[1].label).toBe('Ana — Automação');
    expect(options[2].label).toBe('Bruno');
  });

  it('still offers the create action when there are no leads yet', () => {
    expect(buildLeadSelectOptions([])).toEqual([{ value: NEW_LEAD_OPTION, label: '+ Cadastrar novo cliente' }]);
  });
});

describe('creating a new lead updates the list and auto-selects it', () => {
  it('prepends the created lead to the current list', () => {
    const current = [makeLead({ id: 'lead-1', name: 'Existente' })];
    const created = makeLead({ id: 'lead-2', name: 'Novo' });
    const next = mergeCreatedLead(current, created);
    expect(next).toHaveLength(2);
    expect(next[0].id).toBe('lead-2');
    // Original array is not mutated.
    expect(current).toHaveLength(1);
  });

  it('does not duplicate a lead already present (idempotent merge)', () => {
    const created = makeLead({ id: 'lead-2' });
    const current = [created];
    expect(mergeCreatedLead(current, created)).toBe(current);
  });

  it('auto-selects the created lead by setting only leadId', () => {
    const form = { leadId: '', title: 'Reunião', ownerUserId: 'user-9', startsAt: '2026-10-01T10:00' };
    const created = makeLead({ id: 'lead-42' });
    const next = selectCreatedLead(form, created);
    expect(next.leadId).toBe('lead-42');
  });
});

describe('the main form data is preserved when a client is registered mid-flow', () => {
  it('keeps every other typed field untouched', () => {
    const form = {
      leadId: '',
      title: 'Follow-up importante',
      description: 'Ligar às 15h',
      ownerUserId: 'user-7',
      priority: 'HIGH',
      scheduledAt: '2026-10-02T15:00',
    };
    const next = selectCreatedLead(form, makeLead({ id: 'lead-99' }));
    expect(next).toEqual({ ...form, leadId: 'lead-99' });
  });
});

describe('success feedback', () => {
  it('names the created client in the notice', () => {
    expect(createdLeadNotice(makeLead({ name: 'Rafael Nunes' }))).toContain('Rafael Nunes');
  });
});

describe('buildQuickLeadInput: reuses the CreateLeadInput contract, only necessary fields', () => {
  it('requires a name and drops blank optionals', () => {
    const input = buildQuickLeadInput({ name: '  Maria  ', company: '', email: '', phone: '' });
    expect(input).toEqual({ name: 'Maria' });
  });

  it('includes trimmed optional fields when provided', () => {
    const input = buildQuickLeadInput({
      name: 'Maria',
      company: ' Silva & Cia ',
      email: ' maria@silva.com ',
      phone: ' +55 11 90000-0000 ',
    });
    expect(input).toEqual({
      name: 'Maria',
      company: 'Silva & Cia',
      email: 'maria@silva.com',
      phone: '+55 11 90000-0000',
    });
  });

  it('passes the flow stageId through when given', () => {
    const input = buildQuickLeadInput({ name: 'Maria', company: '', email: '', phone: '' }, 'stage-7');
    expect(input?.stageId).toBe('stage-7');
  });

  it('returns null when the required name is blank (no partial record is created)', () => {
    expect(buildQuickLeadInput({ name: '   ', company: 'X', email: '', phone: '' })).toBeNull();
  });

  it('never includes a tenantId in the payload (server derives it from the token)', () => {
    const input = buildQuickLeadInput({ name: 'Maria', company: '', email: '', phone: '' });
    expect(input).not.toHaveProperty('tenantId');
  });
});
