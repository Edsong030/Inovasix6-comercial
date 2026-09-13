import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FollowUpPriority, FollowUpType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Payload for creating a follow-up. tenantId is NEVER accepted — it comes from
 * the token. status/completedAt/canceledAt are NEVER accepted either: a new
 * follow-up always starts PENDING (Prisma default), those fields only change
 * through the complete/cancel/reschedule actions.
 */
export class CreateFollowUpDto {
  @ApiProperty({
    description: 'Lead ao qual o follow-up pertence (mesmo tenant).',
    format: 'uuid',
    example: '9c1f1b2e-2f3a-4a3a-8e2a-1a2b3c4d5e6f',
  })
  @IsUUID()
  leadId!: string;

  @ApiPropertyOptional({
    description: 'Responsável (usuário do mesmo tenant).',
    format: 'uuid',
    example: '1a2b3c4d-5e6f-4a3a-8e2a-9c1f1b2e2f3a',
  })
  @IsOptional()
  @IsUUID()
  ownerUserId?: string;

  @ApiProperty({ example: 'Retornar sobre proposta' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'Cliente pediu para retornarmos após a reunião de diretoria.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: FollowUpType, example: FollowUpType.WHATSAPP })
  @IsOptional()
  @IsEnum(FollowUpType)
  type?: FollowUpType;

  @ApiPropertyOptional({ enum: FollowUpPriority, example: FollowUpPriority.MEDIUM })
  @IsOptional()
  @IsEnum(FollowUpPriority)
  priority?: FollowUpPriority;

  @ApiProperty({ description: 'Data/hora agendada (ISO 8601).', example: '2026-09-15T14:00:00.000Z' })
  @IsDateString()
  scheduledAt!: string;
}
