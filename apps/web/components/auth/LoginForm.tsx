'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import {
  IconBuilding,
  IconHelp,
  IconInbox,
  IconLogo,
  IconShield,
  IconSparkles,
  IconTrend,
} from '@/components/ui/icons';
import { FullScreenLoader } from '@/components/ui/States';
import { GENERIC_CREDENTIALS_ERROR } from '@/lib/auth/api';
import { useAuth } from '@/lib/auth/auth-context';
import styles from './LoginForm.module.css';

const HIGHLIGHTS = [
  {
    icon: IconInbox,
    title: 'Atendimento unificado',
    text: 'WhatsApp, IA e time humano no mesmo painel, sem conversas perdidas.',
  },
  {
    icon: IconSparkles,
    title: 'IA treinada no seu negócio',
    text: 'Qualifica, responde e agenda usando a base de conhecimento da empresa.',
  },
  {
    icon: IconTrend,
    title: 'Funil sempre atualizado',
    text: 'Cada interação move o lead na régua comercial automaticamente.',
  },
];

export function LoginForm() {
  const router = useRouter();
  const { status, signIn, rememberedSlug, rememberedEmail } = useAuth();

  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill from the last successful sign-in on this browser (never the password).
  useEffect(() => {
    setSlug((current) => current || rememberedSlug);
    setEmail((current) => current || rememberedEmail);
  }, [rememberedSlug, rememberedEmail]);

  // Already signed in (e.g. reached /login via back button) → go to the app.
  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const company = slug.trim().toLowerCase();
    const login = email.trim();
    if (!company || !login || !password) {
      setError(GENERIC_CREDENTIALS_ERROR);
      return;
    }

    setSubmitting(true);
    try {
      await signIn(company, login, password);
      setPassword('');
      router.replace('/');
    } catch (cause) {
      // Rate-limit and network messages are safe to surface; everything else
      // collapses into the single generic credential message.
      const message = cause instanceof Error ? cause.message : GENERIC_CREDENTIALS_ERROR;
      setError(message || GENERIC_CREDENTIALS_ERROR);
      setSubmitting(false);
    }
  };

  if (status === 'loading') return <FullScreenLoader label="Verificando sessão…" />;
  if (status === 'authenticated') return <FullScreenLoader label="Redirecionando…" />;

  return (
    <div className={styles.page}>
      <div className={styles.formColumn}>
        <div className={styles.card}>
          <div className={styles.brand}>
            <span className={styles.mark} aria-hidden="true">
              <IconLogo size={20} />
            </span>
            <span className={styles.brandName}>
              Inovasix<span className={styles.brandSix}>6</span> Comercial IA
            </span>
          </div>

          <h1 className={styles.title}>Entrar na plataforma</h1>
          <p className={styles.subtitle}>
            Informe a empresa e suas credenciais para acessar a operação.
          </p>

          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            {/* aria-live so the error is announced when it appears. */}
            <div role="alert" aria-live="assertive">
              {error ? (
                <p className={styles.alert}>
                  <span className={styles.alertIcon} aria-hidden="true">
                    <IconShield size={16} />
                  </span>
                  {error}
                </p>
              ) : null}
            </div>

            <Field
              label="Empresa"
              name="company"
              autoComplete="organization"
              placeholder="inovasix-demo"
              hint="Identificador (slug) da sua empresa no Inovasix6 Comercial IA."
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              disabled={submitting}
              required
              leading={<IconBuilding size={16} />}
            />

            <Field
              label="Email"
              type="email"
              name="email"
              autoComplete="username"
              placeholder="voce@empresa.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
              required
            />

            <Field
              label="Senha"
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              className={styles.submit}
              loading={submitting}
            >
              {submitting ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>

          <p className={styles.footNote}>
            <span className={styles.footIcon} aria-hidden="true">
              <IconHelp size={14} />
            </span>
            Acesso restrito. Sessões são registradas para auditoria e expiram
            automaticamente por inatividade.
          </p>
        </div>
      </div>

      <aside className={styles.aside} aria-label="Sobre o Inovasix6 Comercial IA">
        <div>
          <h2 className={styles.asideTitle}>
            A operação comercial inteira em{' '}
            <span className="brandGradientText">um só lugar.</span>
          </h2>
        </div>
        <p className={styles.asideText}>
          Centralize atendimento, qualificação por IA, CRM e follow-ups — com o
          controle e a rastreabilidade que uma operação profissional exige.
        </p>
        <div className={styles.highlights}>
          {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
            <div className={styles.highlight} key={title}>
              <span className={styles.highlightIcon} aria-hidden="true">
                <Icon size={17} />
              </span>
              <div>
                <p className={styles.highlightTitle}>{title}</p>
                <p className={styles.highlightText}>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
