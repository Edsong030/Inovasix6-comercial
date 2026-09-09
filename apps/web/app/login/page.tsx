import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/LoginForm';

export const metadata: Metadata = {
  title: 'Entrar · Inovasix6 Comercial IA',
};

export default function LoginPage() {
  return <LoginForm />;
}
