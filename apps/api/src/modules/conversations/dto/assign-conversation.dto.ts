import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Assign (or transfer) the conversation to a user of the SAME tenant. */
export class AssignConversationDto {
  @ApiProperty({
    description: 'Usuário responsável pelo atendimento (mesmo tenant).',
    format: 'uuid',
    example: '1a2b3c4d-5e6f-4a3a-8e2a-9c1f1b2e2f3a',
  })
  @IsUUID()
  userId!: string;
}
