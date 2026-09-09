import { SetMetadata } from '@nestjs/common';
import { RoleCode } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Restrict a handler to the given role codes. Use together with RolesGuard. */
export const Roles = (...roles: RoleCode[]) => SetMetadata(ROLES_KEY, roles);
