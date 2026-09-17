import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Cursor pagination for GET /conversations/:id/messages. Unlike the
 * page/pageSize lists elsewhere, a conversation's history only grows and is
 * read backwards from "now" (chat UX), so a keyset cursor avoids the
 * "page 47 of an ever-growing list" problem an offset would have.
 */
export class ListMessagesQueryDto {
  @ApiPropertyOptional({ description: 'Retorna mensagens anteriores a este id (paginação para trás).' })
  @IsOptional()
  @IsUUID()
  before?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
