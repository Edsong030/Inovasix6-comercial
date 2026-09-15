import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

/** Body for PATCH /follow-ups/:id/reschedule. Only PENDING follow-ups may be rescheduled. */
export class RescheduleFollowUpDto {
  @ApiProperty({ description: 'Nova data/hora agendada (ISO 8601).', example: '2026-09-20T14:00:00.000Z' })
  @IsDateString()
  scheduledAt!: string;
}
