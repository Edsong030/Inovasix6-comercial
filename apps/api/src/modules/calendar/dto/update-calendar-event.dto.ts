import { ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarEventType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Fields updatable via PATCH /calendar/events/:id. Deliberately excludes
 * status — that changes only through the complete/cancel actions.
 */
export class UpdateCalendarEventDto {
  @ApiPropertyOptional({
    description: 'Reassocia o evento a outro lead do mesmo tenant.',
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

  @ApiPropertyOptional({ example: 'Demonstração da plataforma (remarcada)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ example: 'Cliente pediu para incluir o time financeiro.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: CalendarEventType, example: CalendarEventType.CALL })
  @IsOptional()
  @IsEnum(CalendarEventType)
  type?: CalendarEventType;

  @ApiPropertyOptional({
    description: 'Novo início (ISO 8601). Revalida o intervalo com endsAt.',
    example: '2026-09-16T14:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({
    description: 'Novo fim (ISO 8601). Revalida o intervalo com startsAt.',
    example: '2026-09-16T15:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
