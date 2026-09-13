import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarEventType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for creating a calendar event. tenantId is NEVER accepted — it
 * comes from the token. status is NEVER accepted: a new event always starts
 * SCHEDULED (Prisma default); status only changes through complete/cancel.
 */
export class CreateCalendarEventDto {
  @ApiPropertyOptional({
    description: 'Lead associado (opcional; mesmo tenant).',
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

  @ApiProperty({ example: 'Demonstração da plataforma' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'Apresentar o módulo de automação de atendimento.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: CalendarEventType, example: CalendarEventType.MEETING })
  @IsOptional()
  @IsEnum(CalendarEventType)
  type?: CalendarEventType;

  @ApiProperty({ description: 'Início (ISO 8601).', example: '2026-09-15T14:00:00.000Z' })
  @IsDateString()
  startsAt!: string;

  @ApiPropertyOptional({
    description: 'Fim (ISO 8601). Não pode ser anterior a startsAt.',
    example: '2026-09-15T15:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
