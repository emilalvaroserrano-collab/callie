import AuthApp from '@/components/AuthApp';
import { getFirebaseConfig, hasFirebaseConfig } from '@/lib/server-config';

import '@/app/auth.css';

export const metadata = {
  title: 'CSR Studio · Sign In',
  description: 'Sign in to CSR Studio to build and call your AI customer service persona.'
};

export default function AuthPage() {
  const firebaseConfig = getFirebaseConfig();

  if (!hasFirebaseConfig(firebaseConfig)) {
    return (
      <div className="auth-splash">
        <div style={{ maxWidth: 460, padding: 24, textAlign: 'center', fontSize: 14, lineHeight: 1.6 }}>
          Configuration missing. Set the Firebase environment variables in Vercel, then redeploy.
        </div>
      </div>
    );
  }

  return <AuthApp firebaseConfig={firebaseConfig} />;
}
