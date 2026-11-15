import StudioApp from '@/components/StudioApp';
import { getFirebaseConfig, getVapiConfig, hasFirebaseConfig } from '@/lib/server-config';

import '@/app/studio.css';

export const metadata = {
  title: 'CSR Studio · Customize & Call Your AI Agent',
  description:
    'Create and customize a CSR persona, then call it using an isolated Vapi voice session. Responsive mobile-first CSR Studio.'
};

export default function Page() {
  const firebaseConfig = getFirebaseConfig();

  if (!hasFirebaseConfig(firebaseConfig)) {
    return (
      <div className="auth-gate">
        <div style={{ maxWidth: 460, padding: 24, textAlign: 'center', fontSize: 14, lineHeight: 1.6 }}>
          App configuration is missing. Set the Firebase and Vapi environment variables in Vercel,
          then redeploy.
        </div>
      </div>
    );
  }

  return <StudioApp firebaseConfig={firebaseConfig} vapiConfig={getVapiConfig()} />;
}
