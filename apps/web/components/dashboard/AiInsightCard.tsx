import { Button } from '@/components/ui/Button';
import { IconSparkles } from '@/components/ui/icons';
import styles from './Dashboard.module.css';

/**
 * Highlighted "AI copilot" card. Static promo content — no AI endpoints yet.
 * Visually more prominent than ordinary cards (brand border + glow).
 */
export function AiInsightCard() {
  return (
    <section className={`${styles.aiCard} animateRise`} aria-label="Inovasix6 Comercial IA">
      <div className={styles.aiTop}>
        <span className={styles.aiBrand}>
          <span className={styles.aiMark} aria-hidden="true">
            <IconSparkles size={16} />
          </span>
          <span className={styles.aiBrandName}>
            Inovasix<span className={styles.aiSix}>6</span>
          </span>
        </span>
        <span className={styles.aiBadge}>
          <span className={styles.aiBadgeDot} aria-hidden="true" />
          IA sempre ativa
        </span>
      </div>

      <h2 className={styles.aiTitle}>
        Seu copiloto comercial trabalhando <span className={styles.aiGradient}>24h por você.</span>
      </h2>
      <p className={styles.aiText}>
        A IA analisa conversas, qualifica leads, sugere próximas ações e aumenta suas vendas.
      </p>

      <div className={styles.aiActions}>
        <Button variant="primary">Ver insights da IA</Button>
        <Button variant="secondary">Configurar IA</Button>
      </div>
    </section>
  );
}
