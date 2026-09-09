'use client';

import { useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/States';
import { IconInbox, IconSearch, IconSparkles, IconWhatsapp } from '@/components/ui/icons';
import {
  ACTIVE_LEAD,
  CONVERSATIONS,
  CONVERSATION_THREAD,
  type Conversation,
  type ConversationStatus,
  type MessageAuthor,
} from '@/lib/mock/data';
import styles from './Inbox.module.css';

const STATUS_META: Record<ConversationStatus, { label: string; tone: BadgeTone }> = {
  ia: { label: 'IA atendendo', tone: 'accent' },
  humano: { label: 'Atendimento humano', tone: 'info' },
  aguardando: { label: 'Aguardando cliente', tone: 'warning' },
};

const AUTHOR_LABEL: Record<MessageAuthor, string> = {
  cliente: 'Cliente',
  ia: 'IA',
  atendente: 'Atendente',
};

const AUTHOR_CLASS: Record<MessageAuthor, string> = {
  cliente: styles.fromCliente,
  ia: styles.fromIa,
  atendente: styles.fromAtendente,
};

/**
 * Three-pane inbox. All content is mocked: there is no messages backend yet, so
 * selecting a conversation only changes the header/lead panel, and the composer
 * and "Assumir atendimento" are inert by design.
 */
export function InboxView() {
  const [selectedId, setSelectedId] = useState(CONVERSATIONS[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [handedOver, setHandedOver] = useState(false);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return CONVERSATIONS;
    return CONVERSATIONS.filter(
      (item) =>
        item.name.toLowerCase().includes(term) || item.preview.toLowerCase().includes(term),
    );
  }, [query]);

  const selected: Conversation | undefined =
    CONVERSATIONS.find((item) => item.id === selectedId) ?? filtered[0];

  const status = selected ? STATUS_META[handedOver ? 'humano' : selected.status] : null;

  return (
    <div className={styles.inbox}>
      {/* Conversations ---------------------------------------------------- */}
      <section className={`${styles.pane} ${styles.listPane}`} aria-label="Lista de conversas">
        <div className={styles.paneHeader}>
          <h2 className={styles.paneTitle}>Conversas</h2>
          <Badge tone="neutral">{CONVERSATIONS.length}</Badge>
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
              placeholder="Buscar conversa…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className={styles.paneScroll}>
          {filtered.length === 0 ? (
            <EmptyState
              icon={<IconSearch size={18} />}
              title="Nenhuma conversa encontrada"
              description="Ajuste a busca para ver outros atendimentos."
            />
          ) : (
            <ul>
              {filtered.map((item) => {
                const active = selected?.id === item.id;
                const meta = STATUS_META[item.status];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`${styles.conversation} ${active ? styles.conversationActive : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(item.id);
                        setHandedOver(false);
                      }}
                    >
                      <Avatar initials={item.initials} size="md" />
                      <span className={styles.conversationBody}>
                        <span className={styles.conversationTop}>
                          <span className={styles.conversationName}>{item.name}</span>
                          <span className={styles.conversationTime}>{item.time}</span>
                        </span>
                        <span className={styles.conversationPreview}>{item.preview}</span>
                        <span className={styles.conversationMeta}>
                          <Badge tone={meta.tone} dot>
                            {meta.label}
                          </Badge>
                          {item.unread > 0 ? (
                            <span className={styles.unread} aria-label={`${item.unread} não lidas`}>
                              {item.unread}
                            </span>
                          ) : null}
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
              <Avatar initials={selected.initials} size="md" name={selected.name} />
              <span className={styles.threadIdentity}>
                <span className={styles.threadName}>{selected.name}</span>
                <span className={styles.threadChannel}>
                  <IconWhatsapp size={13} />
                  {selected.channel}
                </span>
              </span>
              <span className={styles.threadActions}>
                {status ? (
                  <Badge tone={status.tone} dot>
                    {status.label}
                  </Badge>
                ) : null}
                <Button
                  variant={handedOver ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() => setHandedOver((value) => !value)}
                >
                  <IconSparkles size={15} />
                  {handedOver ? 'Devolver para a IA' : 'Assumir atendimento'}
                </Button>
              </span>
            </div>

            <div className={styles.messages} role="log" aria-label="Histórico da conversa">
              {CONVERSATION_THREAD.map((message) => (
                <div
                  className={`${styles.messageRow} ${AUTHOR_CLASS[message.author]}`}
                  key={message.id}
                >
                  <div className={styles.bubble}>{message.text}</div>
                  <div className={styles.messageMeta}>
                    <span className={styles.authorTag}>{AUTHOR_LABEL[message.author]}</span>
                    <span aria-hidden="true">·</span>
                    <span>{message.time}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.composer}>
              <label className="srOnly" htmlFor="composer">
                Escrever mensagem
              </label>
              <textarea
                id="composer"
                className={styles.composerInput}
                placeholder="Envio de mensagens ainda não disponível nesta versão."
                disabled
                rows={2}
              />
              <div className={styles.composerFoot}>
                <span className={styles.composerNote}>
                  Backend de mensagens ainda não conectado.
                </span>
                <Button variant="primary" size="sm" disabled>
                  Enviar
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Lead details ----------------------------------------------------- */}
      <section className={`${styles.pane} ${styles.details}`} aria-label="Dados do lead">
        <div className={styles.paneHeader}>
          <h2 className={styles.paneTitle}>Dados do lead</h2>
          <Badge tone="accent">{ACTIVE_LEAD.score}</Badge>
        </div>
        <div className={styles.detailsBody}>
          <div className={styles.detailsIdentity}>
            <Avatar initials="MS" size="lg" name={ACTIVE_LEAD.name} />
            <span className={styles.detailsName}>{ACTIVE_LEAD.name}</span>
            <Badge tone="info">{ACTIVE_LEAD.stage}</Badge>
          </div>

          <div className={styles.detailGroup}>
            <h3 className={styles.detailGroupTitle}>Contato</h3>
            <Detail label="Telefone" value={ACTIVE_LEAD.phone} />
            <Detail label="E-mail" value={ACTIVE_LEAD.email} />
            <Detail label="Origem" value={ACTIVE_LEAD.origin} />
          </div>

          <div className={styles.detailGroup}>
            <h3 className={styles.detailGroupTitle}>Comercial</h3>
            <Detail label="Interesse" value={ACTIVE_LEAD.interest} />
            <Detail label="Responsável" value={ACTIVE_LEAD.owner} />
            <Detail label="Criado em" value={ACTIVE_LEAD.createdAt} />
          </div>

          <div className={styles.detailGroup}>
            <h3 className={styles.detailGroupTitle}>Qualificação da IA</h3>
            <div className={styles.tags}>
              {ACTIVE_LEAD.tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </div>
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
