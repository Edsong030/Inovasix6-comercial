import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { IconArrowRight, IconLogo } from '@/components/ui/icons';
import styles from './Banner.module.css';

/**
 * Institutional banner reinforcing the Inovasix6 Comercial IA brand inside the
 * product. Pure CSS gradients/waves/glow — no image, no WebGL.
 */
export function Banner() {
  return (
    <section
      className={`${styles.banner} animateRise`}
      aria-label="Sobre o Inovasix6 Comercial IA"
    >
      <span className={styles.waves} aria-hidden="true" />

      <div className={styles.brandBlock}>
        <span className={styles.brandMark} aria-hidden="true">
          <IconLogo size={22} />
        </span>
        <span className={styles.brandName}>
          Inovasix<span className={styles.brandSix}>6</span>
          <span className={styles.brandSuffix}>Comercial IA</span>
        </span>
      </div>

      <div className={styles.content}>
        <h2 className={styles.title}>
          Mais conversas. Mais vendas. <span className={styles.gradientWord}>Mais resultados.</span>
        </h2>
        <p className={styles.text}>
          Automação, atendimento e inteligência comercial para acelerar o seu crescimento.
        </p>
      </div>

      <div className={styles.action}>
        <Link href="/knowledge">
          <Button variant="primary" size="lg">
            Conheça todas as possibilidades
            <IconArrowRight size={16} />
          </Button>
        </Link>
      </div>
    </section>
  );
}
