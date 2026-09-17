'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/States';
import { IconInbox, IconMessage, IconSearch, IconWhatsapp } from '@/components/ui/icons';
import {
  assignConversation,
  changeConversationState,
  listAssignableUsers,
  listConversations,
  listMessages,
  sendMessage,
  unassignConversation,
} from '@/lib/api/resources';
import type {
  AssignableUser,
  ConversationChannel,
  ConversationItem,
  ConversationState,
  ConversationListResult,
  MessageItem,
  MessageListResult,
  MessageSenderType,
} from '@/lib/api/types';
import { useApiResource } from '@/lib/api/useApiResource';
import { useAuth } from '@/lib/auth/auth-context';
import { formatDateTime, formatTime } from '@/lib/datetime';
import styles from './Inbox.module.css';

// -- Pure helpers (exported for unit tests — see InboxView.spec.ts) -----------

/** Two-letter avatar initials from a (possibly missing) contact name. */
export function initialsFromName(name: string | null): string {
  if (!name) return '?';
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return initials || '?';
}

/** Same "find selection, fall back to the first item" rule the old mock UI used. */
export function resolveSelectedConversation(
  items: ConversationItem[],
  selectedId: string,
): ConversationItem | undefined {
  return items.find((c) => c.id === selectedId) ?? items[0];
}

/** Blocks empty/whitespace-only sends; trims before it ever reaches the API. */
export function buildSendMessageInput(raw: string): string | null {
  const body = raw.trim();
  return body.length > 0 ? body : null;
}

/** Empty `userId` ("Nenhum" option) means unassign; anything else means assign to that user. */
export function resolveAssigneeChange(
  chosenUserId: string,
): { action: 'assign'; userId: string } | { action: 'unassign' } {
  return chosenUserId ? { action: 'assign', userId: chosenUserId } : { action: 'unassign' };
}

/**
 * Guards against the one-frame window where React has already re-rendered
 * with a new `selectedId` but the messages effect (keyed on that id) has not
 * fired yet — without this, the OLD conversation's already-loaded messages
 * would flash before the new fetch resolves. Vacuously safe for an empty
 * page (nothing to contaminate) or before anything has loaded.
 */
export function isMessagesDataForConversation(
  data: MessageListResult | null,
  conversationId: string,
): boolean {
  if (!data) return false;
  if (data.items.length === 0) return true;
  return data.items[0].conversationId === conversationId;
}

/**
 * Mirrors ConversationsService.ALLOWED_TRANSITIONS on the backend exactly
 * (apps/api/src/modules/conversations/conversations.service.ts). HUMANO_ATENDENDO
 * is intentionally unreachable here — it is only ever entered as a side
 * effect of assigning the conversation, never a direct state change.
 */
const CONVERSATION_STATE_TRANSITIONS: Partial<Record<ConversationState, ConversationState[]>> = {
  AI_ATENDENDO: ['AGUARDANDO_HUMANO', 'ENCERRADA'],
  AGUARDANDO_HUMANO: ['ENCERRADA'],
  HUMANO_ATENDENDO: ['ENCERRADA'],
  ENCERRADA: ['AGUARDANDO_HUMANO'],
};

export function nextStateOptions(current: ConversationState): ConversationState[] {
  return CONVERSATION_STATE_TRANSITIONS[current] ?? [];
}

export const CONVERSATION_STATE_LABELS: Record<ConversationState, { label: string; tone: BadgeTone }> = {
  AI_ATENDENDO: { label: 'IA atendendo', tone: 'accent' },
  AGUARDANDO_HUMANO: { label: 'Aguardando atendimento', tone: 'warning' },
  HUMANO_ATENDENDO: { label: 'Atendimento humano', tone: 'info' },
  ENCERRADA: { label: 'Encerrada', tone: 'neutral' },
};

const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  MANUAL: 'Manual',
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  WEBCHAT: 'Webchat',
};

const SENDER_LABEL: Record<MessageSenderType, string> = {
  CUSTOMER: 'Cliente',
  AGENT: 'Atendente',
  SYSTEM: 'Sistema',
  AI: 'IA',
};

/** CUSTOMER renders on the left; everything else (AGENT/SYSTEM/AI) on the right. */
function messageRowClass(senderType: MessageSenderType): string {
  if (senderType === 'CUSTOMER') return styles.fromCliente;
  if (senderType === 'AI') return styles.fromIa;
  return styles.fromAtendente;
}

const DEBOUNCE_MS = 300;

/**
 * Three-pane Inbox wired to the real Conversations/Messages API (STEP 3).
 *
 * Gaps documented rather than fabricated (the API does not provide these):
 *  - no message preview/snippet in the conversation list (only lastMessageAt);
 *  - no unread counter;
 *  - no Lead name/company on the conversation (the endpoint joins Contact,
 *    not Lead) — only whether a Lead is linked (leadId) is known here.
 *  - no way to CREATE a conversation from the UI yet (no such endpoint exists
 *    on the backend) — this view can only browse/operate on conversations
 *    that already exist in the database.
 */
export function InboxView() {
  const { user } = useAuth();
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const conversationsFetcher = useCallback(
    (signal: AbortSignal): Promise<ConversationListResult> =>
      listConversations({ search: debouncedSearch || undefined, pageSize: 50 }, signal),
    [debouncedSearch],
  );
  const conversations = useApiResource<ConversationListResult>(conversationsFetcher, [debouncedSearch]);

  const items = conversations.data?.items ?? [];
  const selected = useMemo(
    () => resolveSelectedConversation(conversations.data?.items ?? [], selectedId),
    [conversations.data, selectedId],
  );
  const effectiveSelectedId = selected?.id ?? '';

  // Keep the actual selection state in sync with what resolveSelectedConversation
  // picked (e.g. auto-selecting the first conversation on initial load).
  useEffect(() => {
    if (effectiveSelectedId && effectiveSelectedId !== selectedId) setSelectedId(effectiveSelectedId);
  }, [effectiveSelectedId, selectedId]);

  const messagesFetcher = useCallback(
    (signal: AbortSignal): Promise<MessageListResult> =>
      effectiveSelectedId
        ? listMessages(effectiveSelectedId, { limit: 50 }, signal)
        : Promise.resolve({ items: [], nextCursor: null, hasMore: false }),
    [effectiveSelectedId],
  );
  const messages = useApiResource<MessageListResult>(messagesFetcher, [effectiveSelectedId]);
  const messagesReady =
    messages.state === 'ready' && isMessagesDataForConversation(messages.data, effectiveSelectedId);

  const assignableFetcher = useCallback(
    (signal: AbortSignal): Promise<AssignableUser[]> => listAssignableUsers(signal),
    [],
  );
  const assignable = useApiResource<AssignableUser[]>(assignableFetcher, []);

  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  const [stateBusy, setStateBusy] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const selectConversation = (id: string) => {
    setSelectedId(id);
    setSendError(null);
    setAssignError(null);
    setStateError(null);
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending || !selected) return;
    const body = buildSendMessageInput(composerText);
    if (!body) {
      setSendError('Escreva uma mensagem antes de enviar.');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await sendMessage(selected.id, body);
      setComposerText('');
      messages.reload();
      conversations.reload();
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSending(false);
    }
  };

  const applyAssigneeChange = async (chosenUserId: string) => {
    if (!selected || assignBusy) return;
    setAssignBusy(true);
    setAssignError(null);
    try {
      const change = resolveAssigneeChange(chosenUserId);
      if (change.action === 'assign') {
        await assignConversation(selected.id, change.userId);
      } else {
        await unassignConversation(selected.id);
      }
      conversations.reload();
    } catch (cause) {
      setAssignError(cause instanceof Error ? cause.message : 'Não foi possível atualizar o responsável.');
    } finally {
      setAssignBusy(false);
    }
  };

  const applyStateChange = async (target: ConversationState) => {
    if (!selected || stateBusy) return;
    setStateBusy(true);
    setStateError(null);
    try {
      await changeConversationState(selected.id, target);
      conversations.reload();
    } catch (cause) {
      setStateError(cause instanceof Error ? cause.message : 'Não foi possível alterar o estado da conversa.');
    } finally {
      setStateBusy(false);
    }
  };

  const isMine = !!user && !!selected && selected.assignedUserId === user.userId;

  return (
    <div className={styles.inbox}>
      {/* Conversations ---------------------------------------------------- */}
      <section className={`${styles.pane} ${styles.listPane}`} aria-label="Lista de conversas">
        <div className={styles.paneHeader}>
          <h2 className={styles.paneTitle}>Conversas</h2>
          <Badge tone="neutral">{conversations.state === 'ready' ? conversations.data?.total ?? 0 : '—'}</Badge>
        </div>
        <div className={styles.searchWrap}>
          <label className="srOnly" htmlFor="inbox-search">
            Buscar conversas
          </label>
          <div className={styles.searchControl}>
            <span className={styles.searchIcon} aria-hidden="true">
              <IconSearch size={15} />
            </span>
            <input
              id="inbox-search"
              type="search"
              className={styles.searchField}
              placeholder="Buscar por nome, telefone ou e-mail…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div className={styles.paneScroll}>
          {conversations.state === 'loading' ? (
            <div className={styles.paneLoading} role="status">
              <Spinner size={20} />
              <span>Carregando conversas…</span>
            </div>
          ) : conversations.state === 'error' ? (
            <ErrorState
              title="Não foi possível carregar as conversas"
              description={conversations.error ?? undefined}
              action={
                <Button variant="secondary" size="sm" onClick={conversations.reload}>
                  Tentar novamente
                </Button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<IconSearch size={18} />}
              title="Nenhuma conversa encontrada"
              description={
                debouncedSearch
                  ? 'Ajuste a busca para ver outros atendimentos.'
                  : 'Quando houver conversas neste tenant, elas aparecem aqui.'
              }
            />
          ) : (
            <ul>
              {items.map((item) => {
                const active = effectiveSelectedId === item.id;
                const meta = CONVERSATION_STATE_LABELS[item.state];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`${styles.conversation} ${active ? styles.conversationActive : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => selectConversation(item.id)}
                    >
                      <Avatar initials={initialsFromName(item.contactName)} size="md" />
                      <span className={styles.conversationBody}>
                        <span className={styles.conversationTop}>
                          <span className={styles.conversationName}>{item.contactName ?? 'Sem nome'}</span>
                          <span className={styles.conversationTime}>
                            {item.lastMessageAt ? formatDateTime(item.lastMessageAt) : '—'}
                          </span>
                        </span>
                        <span className={styles.conversationPreview}>
                          {item.subject ?? (item.lastMessageAt ? '' : 'Sem mensagens ainda')}
                        </span>
                        <span className={styles.conversationMeta}>
                          <Badge tone={meta.tone} dot>
                            {meta.label}
                          </Badge>
                          <span className={styles.channelTag}>{CHANNEL_LABELS[item.channel]}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Thread ----------------------------------------------------------- */}
      <section className={`${styles.pane} ${styles.threadPane}`} aria-label="Conversa selecionada">
        {!selected ? (
          <EmptyState
            icon={<IconInbox size={19} />}
            title="Selecione uma conversa"
            description="Escolha um atendimento na lista para ver o histórico."
          />
        ) : (
          <>
            <div className={styles.threadHeader}>
              <Avatar initials={initialsFromName(selected.contactName)} size="md" name={selected.contactName ?? 'Sem nome'} />
              <span className={styles.threadIdentity}>
                <span className={styles.threadName}>{selected.contactName ?? 'Sem nome'}</span>
                <span className={styles.threadChannel}>
                  {selected.channel === 'WHATSAPP' ? <IconWhatsapp size={13} /> : <IconMessage size={13} />}
                  {CHANNEL_LABELS[selected.channel]}
                </span>
              </span>
              <span className={styles.threadActions}>
                <Badge tone={CONVERSATION_STATE_LABELS[selected.state].tone} dot>
                  {CONVERSATION_STATE_LABELS[selected.state].label}
                </Badge>
                {nextStateOptions(selected.state).length > 0 ? (
                  <select
                    aria-label="Alterar estado da conversa"
                    className={styles.inlineSelect}
                    value=""
                    disabled={stateBusy}
                    onChange={(event) => {
                      if (event.target.value) applyStateChange(event.target.value as ConversationState);
                    }}
                  >
                    <option value="">Alterar estado…</option>
                    {nextStateOptions(selected.state).map((option) => (
                      <option key={option} value={option}>
                        {CONVERSATION_STATE_LABELS[option].label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {user ? (
                  <Button
                    variant={isMine ? 'secondary' : 'primary'}
                    size="sm"
                    disabled={assignBusy || selected.state === 'ENCERRADA'}
                    onClick={() => applyAssigneeChange(isMine ? '' : user.userId)}
                  >
                    {isMine ? 'Desatribuir' : 'Assumir atendimento'}
                  </Button>
                ) : null}
              </span>
            </div>

            {stateError ? (
              <p className={styles.inlineError} role="alert">
                {stateError}
              </p>
            ) : null}
            {assignError ? (
              <p className={styles.inlineError} role="alert">
                {assignError}
              </p>
            ) : null}

            <div className={styles.messages} role="log" aria-label="Histórico da conversa">
              {!messagesReady ? (
                messages.state === 'error' ? (
                  <ErrorState
                    title="Não foi possível carregar as mensagens"
                    description={messages.error ?? undefined}
                    action={
                      <Button variant="secondary" size="sm" onClick={messages.reload}>
                        Tentar novamente
                      </Button>
                    }
                  />
                ) : (
                  <div className={styles.paneLoading} role="status">
                    <Spinner size={20} />
                    <span>Carregando mensagens…</span>
                  </div>
                )
              ) : messages.data!.items.length === 0 ? (
                <EmptyState
                  icon={<IconMessage size={18} />}
                  title="Nenhuma mensagem ainda"
                  description="Quando houver mensagens nesta conversa, elas aparecem aqui."
                />
              ) : (
                messages.data!.items.map((message: MessageItem) => (
                  <div className={`${styles.messageRow} ${messageRowClass(message.senderType)}`} key={message.id}>
                    <div className={styles.bubble}>{message.body}</div>
                    <div className={styles.messageMeta}>
                      <span className={styles.authorTag}>
                        {message.senderType === 'AGENT' && message.senderUserName
                          ? message.senderUserName
                          : SENDER_LABEL[message.senderType]}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <form className={styles.composer} onSubmit={handleSend}>
              <label className="srOnly" htmlFor="composer">
                Escrever mensagem
              </label>
              <textarea
                id="composer"
                className={styles.composerInput}
                placeholder={selected.state === 'ENCERRADA' ? 'Reabra a conversa para responder.' : 'Escreva uma mensagem…'}
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                disabled={sending || selected.state === 'ENCERRADA'}
                maxLength={4000}
                rows={2}
              />
              <div className={styles.composerFoot}>
                {sendError ? (
                  <span className={styles.inlineError} role="alert">
                    {sendError}
                  </span>
                ) : (
                  <span className={styles.composerNote}>Enviado como você, para esta conversa.</span>
                )}
                <Button type="submit" variant="primary" size="sm" loading={sending} disabled={selected.state === 'ENCERRADA'}>
                  {sending ? 'Enviando…' : 'Enviar'}
                </Button>
              </div>
            </form>
          </>
        )}
      </section>

      {/* Contact / Lead / Atendente ----------------------------------------- */}
      <section className={`${styles.pane} ${styles.details}`} aria-label="Dados do contato">
        <div className={styles.paneHeader}>
          <h2 className={styles.paneTitle}>Dados do contato</h2>
        </div>
        {!selected ? (
          <div className={styles.detailsBody}>
            <EmptyState title="Nenhuma conversa selecionada" description="Selecione um atendimento para ver os detalhes." />
          </div>
        ) : (
          <div className={styles.detailsBody}>
            <div className={styles.detailsIdentity}>
              <Avatar initials={initialsFromName(selected.contactName)} size="lg" name={selected.contactName ?? 'Sem nome'} />
              <span className={styles.detailsName}>{selected.contactName ?? 'Sem nome'}</span>
              <Badge tone={selected.leadId ? 'info' : 'neutral'}>
                {selected.leadId ? 'Lead vinculado' : 'Sem lead vinculado'}
              </Badge>
            </div>

            <div className={styles.detailGroup}>
              <h3 className={styles.detailGroupTitle}>Contato (Cliente/Lead)</h3>
              <Detail label="Telefone" value={selected.contactPhone ?? '—'} />
              <Detail label="E-mail" value={selected.contactEmail ?? '—'} />
              <Detail label="Canal" value={CHANNEL_LABELS[selected.channel]} />
            </div>

            <div className={styles.detailGroup}>
              <h3 className={styles.detailGroupTitle}>Atendente responsável</h3>
              <label className="srOnly" htmlFor="inbox-assignee">
                Atendente responsável
              </label>
              <select
                id="inbox-assignee"
                className={styles.select}
                value={selected.assignedUserId ?? ''}
                disabled={assignBusy || assignable.state !== 'ready' || selected.state === 'ENCERRADA'}
                onChange={(event) => applyAssigneeChange(event.target.value)}
              >
                <option value="">Nenhum</option>
                {(assignable.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailItem}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>{value}</span>
    </div>
  );
}
