import { ApiPropertyOptional } from '@nestjs/swagger';
import { FollowUpPriority, FollowUpType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Fields updatable via PATCH /follow-ups/:id. Deliberately excludes status,
 * completedAt, canceledAt and scheduledAt — those change only through the
 * complete/cancel/reschedule actions, never through this generic update.
 */
export class UpdateFollowUpDto {
  @ApiPropertyOptional({
    description: 'Reassocia o follow-up a outro lead do mesmo tenant.',
    format: 'uuid',
    example: '9c1f1b2e-2f3a-4a3a-8e2a-1a2b3c4d5e6f',
  })
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @ApiPropertyOptional({
    description: 'Responsável (usuário do mesmo tenant).',
    format: 'uuid',
    example: '1a2b3c4d-5e6f-4a3a-8e2a-9c1f1b2e2f3a',
  })
  @IsOptional()
  @IsUUID()
  ownerUserId?: string;

  @ApiPropertyOptional({ example: 'Retornar sobre proposta (revisado)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ example: 'Atualizado após retorno do cliente.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: FollowUpType, example: FollowUpType.CALL })
  @IsOptional()
  @IsEnum(FollowUpType)
  type?: FollowUpType;

  @ApiPropertyOptional({ enum: FollowUpPriority, example: FollowUpPriority.HIGH })
  @IsOptional()
  @IsEnum(FollowUpPriority)
  priority?: FollowUpPriority;
}
