import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import styles from './not-found.module.css';

export default function NotFound() {
  return (
    <main className={styles.wrap} id="conteudo-principal">
      <p className={styles.code}>Erro 404</p>
      <h1 className={styles.title}>Página não encontrada</h1>
      <p className={styles.text}>
        O endereço acessado não existe ou foi movido. Verifique o link ou volte para o
        painel.
      </p>
      <div className={styles.action}>
        <Link href="/">
          <Button variant="primary">Voltar ao painel</Button>
        </Link>
      </div>
    </main>
  );
}
