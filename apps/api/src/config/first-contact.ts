/**
 * First-contact acknowledgement: the automatic reply a new conversation gets
 * before a person takes over. Server-side default, overridable with the
 * optional FIRST_CONTACT_MESSAGE environment variable (no code change, same
 * text for every tenant).
 *
 * Per-tenant text is deliberately not modelled: Tenant has no settings column,
 * so it would need a new table/column (and a migration). FirstContactService
 * resolves the text through one method (`messageFor`), which is where a
 * per-tenant lookup would plug in.
 */
export const DEFAULT_FIRST_CONTACT_MESSAGE =
  'Olá! Seja bem-vindo. Recebemos sua mensagem e já vamos direcionar seu atendimento para nossa equipe. ' +
  'Enquanto isso, se quiser, pode nos contar brevemente como podemos ajudar.';

/** Same ceiling as a message written by an agent (CreateMessageDto). */
export const MAX_FIRST_CONTACT_MESSAGE_LENGTH = 4000;
