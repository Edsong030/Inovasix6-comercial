import { NotFoundException } from '@nestjs/common';
import { TenantResourceService } from './tenant-resource.service';

describe('TenantResourceService (IDOR / cross-tenant isolation)', () => {
  const service = new TenantResourceService();

  it('allows Tenant A to access its own resource', () => {
    const resource = { id: 'lead-a', tenantId: 'tenant-a' };
    expect(service.assertBelongsToTenant(resource, 'tenant-a')).toBe(resource);
  });

  it('blocks Tenant A from accessing a Tenant B resource with 404 (not 403)', () => {
    expect(() =>
      service.assertBelongsToTenant({ id: 'lead-b', tenantId: 'tenant-b' }, 'tenant-a'),
    ).toThrow(NotFoundException);
  });

  it('returns 404 for a non-existent resource', () => {
    expect(() => service.assertBelongsToTenant(null, 'tenant-a')).toThrow(NotFoundException);
  });

  it('produces an identical observable response for missing vs cross-tenant', () => {
    let missingError: unknown;
    let crossTenantError: unknown;

    try {
      service.assertBelongsToTenant(null, 'tenant-a');
    } catch (error) {
      missingError = error;
    }
    try {
      service.assertBelongsToTenant({ id: 'x', tenantId: 'tenant-b' }, 'tenant-a');
    } catch (error) {
      crossTenantError = error;
    }

    expect(missingError).toBeInstanceOf(NotFoundException);
    expect(crossTenantError).toBeInstanceOf(NotFoundException);
    expect((crossTenantError as NotFoundException).getStatus()).toBe(
      (missingError as NotFoundException).getStatus(),
    );
    expect((crossTenantError as NotFoundException).message).toBe(
      (missingError as NotFoundException).message,
    );
  });
});
