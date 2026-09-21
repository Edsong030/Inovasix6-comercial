import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { getCountries } from 'libphonenumber-js/max';
import type { CountryCode } from 'libphonenumber-js/max';

/**
 * Limits. Ids are provider-issued opaque strings (WhatsApp message ids are
 * ~100 chars, wa_id <= 15 digits, webchat ids are UUIDs), so 255 leaves ample
 * room without accepting absurd values. `content` matches the agent API
 * (CreateMessageDto): 1..4000 characters.
 */
const MAX_EXTERNAL_ID = 255;
const MAX_CONTENT = 4000;

/** ISO 8601 must carry an explicit offset: a bare local time is ambiguous. */
const HAS_UTC_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Who sent the message, as far as the channel knows. Optional; only used to
 * create/match the Contact.
 */
export class InboundContactDto {
  @ApiPropertyOptional({ example: 'Ana Souza', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Telefone JÁ VERIFICADO pelo canal (ex.: WhatsApp). Um telefone igual ao de um contato existente do tenant liga esta identidade a ele; não envie telefone digitado por usuário não verificado. Formato E.164 ou nacional (com defaultCountry).',
    example: '+5541999999999',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ example: 'ana@example.com', maxLength: 254 })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    description: 'País (ISO 3166-1 alpha-2, maiúsculas) usado para interpretar telefone em formato nacional.',
    example: 'BR',
  })
  @IsOptional()
  @IsIn(getCountries())
  defaultCountry?: CountryCode;
}

/**
 * One inbound event from a channel.
 *
 * There is deliberately NO tenantId and NO channel here: both come from the
 * authenticated service credential, and the global ValidationPipe
 * (forbidNonWhitelisted) rejects a body that tries to send them with 400.
 */
export class InboundMessageDto {
  @ApiProperty({ description: 'Id do remetente no canal (wa_id, visitor id, id do Instagram...).', maxLength: MAX_EXTERNAL_ID })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_EXTERNAL_ID)
  externalContactId!: string;

  @ApiPropertyOptional({
    description: 'Id da thread/sessão no provedor, quando existir (webchat, Instagram). Identifica a conversa ABERTA daquela thread.',
    maxLength: MAX_EXTERNAL_ID,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_EXTERNAL_ID)
  externalConversationId?: string;

  @ApiProperty({
    description:
      'Id da mensagem no provedor. Chave de idempotência: único por tenant; o primeiro evento persistido vence e reenvios retornam 200.',
    maxLength: MAX_EXTERNAL_ID,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_EXTERNAL_ID)
  externalMessageId!: string;

  @ApiPropertyOptional({ type: InboundContactDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InboundContactDto)
  contact?: InboundContactDto;

  @ApiProperty({ description: 'Texto da mensagem (1 a 4000 caracteres, sem trim).', maxLength: MAX_CONTENT })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CONTENT)
  content!: string;

  @ApiPropertyOptional({
    description: 'Quando o provedor enviou a mensagem (ISO 8601 com fuso, ex.: 2024-01-01T10:00:00Z). Futuro é limitado ao instante de recebimento.',
    example: '2024-01-01T10:00:00Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(HAS_UTC_OFFSET, { message: 'occurredAt must include a UTC offset (e.g. Z or +00:00)' })
  occurredAt?: string;
}

/** Public result: ids and flags only, no internal objects. */
export class InboundMessageResultDto {
  @ApiProperty({ description: 'true quando o externalMessageId já havia sido processado (reentrega).' })
  duplicate!: boolean;

  @ApiProperty({ format: 'uuid' })
  contactId!: string;

  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ format: 'uuid' })
  messageId!: string;

  @ApiProperty()
  contactCreated!: boolean;

  @ApiProperty()
  identityCreated!: boolean;

  @ApiProperty()
  conversationCreated!: boolean;

  @ApiProperty()
  messageCreated!: boolean;
}
