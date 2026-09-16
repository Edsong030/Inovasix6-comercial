import { DemoBanner } from '@/components/DemoBanner';
import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth/auth-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Inovasix6 Comercial IA',
  description: 'Atendimento, vendas e inteligência comercial em um só lugar.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#070911',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        <a className="skipLink" href="#conteudo-principal">
          Ir para o conteúdo principal
        </a>
        {/* Session state is required by both the login screen and the shell. */}
        <AuthProvider><DemoBanner />{children}</AuthProvider>
      </body>
    </html>
  );
}
