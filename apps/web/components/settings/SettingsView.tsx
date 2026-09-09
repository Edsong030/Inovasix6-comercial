'use client';

import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import {
  IconBuilding,
  IconClock,
  IconInbox,
  IconPlug,
  IconShield,
} from '@/components/ui/icons';
import { useAuth } from '@/lib/auth/auth-context';
import styles from './Settings.module.css';

type SectionId = 'empresa' | 'atendimento' | 'horarios' | 'seguranca' | 'integracoes';

const SECTIONS: { id: SectionId; label: string; icon: typeof IconBuilding }[] = [
  { id: 'empresa', label: 'Empresa', icon: IconBuilding },
  { id: 'atendimento', label: 'Atendimento', icon: IconInbox },
  { id: 'horarios', label: 'Horários', icon: IconClock },
  { id: 'seguranca', label: 'Segurança', icon: IconShield },
  { id: 'integracoes', label: 'Integrações', icon: IconPlug },
];

/** Settings shell. Nothing persists — no settings endpoints exist yet. */
export function SettingsView() {
  const { user } = useAuth();
  const [section, setSection] = useState<SectionId>('empresa');

  return (
    <>
      <div className={styles.notice}>
        <span className={styles.noticeIcon} aria-hidden="true">
          <IconShield size={17} />
        </span>
        <p className={styles.noticeText}>
          As configurações abaixo são apenas visuais nesta versão. Nada é salvo — a
          persistência depende dos endpoints de configuração do backend.
        </p>
      </div>

      <div className={styles.layout}>
        <nav className={styles.sectionNav} aria-label="Seções de configuração">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => setSection(item.id)}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className={styles.panels}>
          {section === 'empresa' ? (
            <Card ariaLabel="Configurações da empresa">
              <CardHeader title="Empresa" subtitle="Identificação do tenant nesta plataforma" />
              <CardBody flush>
                <div className={styles.rows}>
                  <Row label="Nome da empresa" hint="Exibido no painel e nas mensagens.">
                    <p className={styles.readonlyValue}>{user?.companyName ?? '—'}</p>
                  </Row>
                  <Row label="Slug" hint="Identificador usado no login.">
                    <p className={styles.readonlyValue}>{user?.slug || '—'}</p>
                  </Row>
                  <Row label="ID do tenant" hint="Chave de isolamento multi-tenant.">
                    <p className={styles.readonlyValue}>{user?.tenantId ?? '—'}</p>
                  </Row>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {section === 'atendimento' ? (
            <Card ariaLabel="Configurações de atendimento">
              <CardHeader title="Atendimento" subtitle="Comportamento da IA e do time" />
              <CardBody flush>
                <div className={styles.rows}>
                  <Row label="IA responde automaticamente" hint="Primeiro contato feito pela IA.">
                    <Badge tone="success" dot>
                      Ativado
                    </Badge>
                  </Row>
                  <Row
                    label="Transferir para humano"
                    hint="Quando o lead pedir ou a IA não souber responder."
                  >
                    <Badge tone="accent">Automático</Badge>
                  </Row>
                  <Row label="Tom de voz" hint="Estilo das respostas geradas.">
                    <p className={styles.readonlyValue}>Profissional e cordial</p>
                  </Row>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {section === 'horarios' ? (
            <Card ariaLabel="Horários de atendimento">
              <CardHeader title="Horários" subtitle="Janela de atendimento humano" />
              <CardBody flush>
                <div className={styles.rows}>
                  <Row label="Segunda a sexta">
                    <p className={styles.readonlyValue}>09:00 – 18:00</p>
                  </Row>
                  <Row label="Sábado">
                    <p className={styles.readonlyValue}>09:00 – 13:00</p>
                  </Row>
                  <Row label="Fora do horário" hint="Quem atende quando o time está offline.">
                    <Badge tone="accent">IA 24/7</Badge>
                  </Row>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {section === 'seguranca' ? (
            <Card ariaLabel="Configurações de segurança">
              <CardHeader title="Segurança" subtitle="Sessão e acesso" />
              <CardBody flush>
                <div className={styles.rows}>
                  <Row
                    label="Access token"
                    hint="Mantido apenas em memória, nunca em localStorage."
                  >
                    <Badge tone="success" dot>
                      Somente em memória
                    </Badge>
                  </Row>
                  <Row
                    label="Refresh token"
                    hint="Cookie HttpOnly com rotação e detecção de reuso."
                  >
                    <Badge tone="success" dot>
                      Cookie HttpOnly
                    </Badge>
                  </Row>
                  <Row label="Papel neste tenant" hint="Definido pelo backend, não editável aqui.">
                    <p className={styles.readonlyValue}>{user?.roleLabel ?? '—'}</p>
                  </Row>
                  <Row label="Encerrar outras sessões" hint="Disponível quando a tela de conta existir.">
                    <Button variant="secondary" size="sm" disabled>
                      Encerrar sessões
                    </Button>
                  </Row>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {section === 'integracoes' ? (
            <Card ariaLabel="Integrações">
              <CardHeader title="Integrações" subtitle="Canais e serviços conectados" />
              <CardBody flush>
                <div className={styles.rows}>
                  <Row label="WhatsApp Business" hint="Canal principal de atendimento.">
                    <Badge tone="neutral" dot>
                      Não conectado
                    </Badge>
                  </Row>
                  <Row label="Google Calendar" hint="Sincronização de agendamentos.">
                    <Badge tone="neutral" dot>
                      Não conectado
                    </Badge>
                  </Row>
                  <Row label="Webhooks" hint="Notificações para sistemas externos.">
                    <Badge tone="neutral" dot>
                      Não configurado
                    </Badge>
                  </Row>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div>
        <p className={styles.rowLabel}>{label}</p>
        {hint ? <p className={styles.rowHint}>{hint}</p> : null}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}
