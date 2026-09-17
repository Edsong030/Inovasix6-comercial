import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleCode } from '@prisma/client';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UsersService, type AssignableUserItem } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('assignable')
  @Roles(RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL, RoleCode.ATENDENTE)
  @ApiOperation({
    summary:
      'Lista usuários internos ATIVOS do tenant atual, elegíveis como "Atendente responsável". Nunca lista leads nem usuários de outro tenant.',
  })
  listAssignable(@CurrentTenant() ctx: TenantContext): Promise<AssignableUserItem[]> {
    return this.users.listAssignable(ctx);
  }
}
