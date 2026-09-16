'use client';
import { DEMO_MODE, resetDemo } from '@/lib/demo/api';
export function DemoBanner() {
  if (!DEMO_MODE) return null;
  return <aside className="demoNotice" role="status" aria-label="Modo de demonstração: dados fictícios, alterações ficam nesta aba, mensagens e integrações são simuladas."><span>Demonstração</span><button type="button" onClick={resetDemo}>Reiniciar</button></aside>;
}
