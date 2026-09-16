'use client';
import { DEMO_MODE, resetDemo } from '@/lib/demo/api';
export function DemoBanner() {
  if (!DEMO_MODE) return null;
  return <aside className="demoNotice" aria-label="Modo de demonstração"><span><strong>Demonstração</strong> · Dados fictícios. Alterações ficam nesta aba; mensagens e integrações são simuladas.</span><button type="button" onClick={resetDemo}>Reiniciar demonstração</button></aside>;
}
