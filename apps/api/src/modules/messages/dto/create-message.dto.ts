import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for sending a manual message as the authenticated agent. Only the
 * body is client-controlled — direction/senderType/senderUserId/status are
 * NEVER accepted from the client; a message sent through this endpoint is
 * always OUTBOUND/AGENT, attributed to the caller from the token.
 */
export class CreateMessageDto {
  @ApiProperty({ example: 'Oi! Já te retorno com os detalhes.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}
