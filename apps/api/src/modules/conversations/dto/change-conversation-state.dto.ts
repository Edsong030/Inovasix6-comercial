import { ApiProperty } from '@nestjs/swagger';
import { ConversationState } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * Target state for PATCH /conversations/:id/state. Not every enum value is a
 * valid target from every current state — the service validates the specific
 * transition (see ALLOWED_TRANSITIONS in conversations.service.ts).
 */
export class ChangeConversationStateDto {
  @ApiProperty({ enum: ConversationState, example: ConversationState.ENCERRADA })
  @IsEnum(ConversationState)
  state!: ConversationState;
}
