'use client';

import { useEffect } from 'react';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  updateProfile
} from 'firebase/auth';
import { getDatabase, ref, get, update, serverTimestamp } from 'firebase/database';

const REDIRECT_GUARD_KEY = 'csr-redirect-guard';
const APP_URL = '/';
const AUTH_URL = '/auth';

export default function AuthApp({ firebaseConfig }) {
  useEffect(() => {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getDatabase(app);
    const googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: 'select_account' });

    const $ = (id) => document.getElementById(id);
    let mode = 'signin';
    let busy = false;
    let redirecting = false;
    let splashTimer = null;
    let homeTimer = null;
    let disposed = false;

    function hideSplash() {
      clearTimeout(splashTimer);
      const splash = $('authSplash');
      if (splash) splash.classList.add('hidden');
    }

    function clearRedirectGuard() {
      try {
        sessionStorage.removeItem(REDIRECT_GUARD_KEY);
      } catch (error) {}
    }

    /* Stops an auth <-> app ping-pong loop when the session cannot be resolved. */
    function redirectCountExceeded() {
      try {
        const now = Date.now();
        const hops = JSON.parse(sessionStorage.getItem(REDIRECT_GUARD_KEY) || '[]')
          .filter((time) => typeof time === 'number' && now - time < 6000);
        hops.push(now);
        sessionStorage.setItem(REDIRECT_GUARD_KEY, JSON.stringify(hops));
        return hops.length > 3;
      } catch (error) {
        return false;
      }
    }

    /* Only allow same-origin, non-auth destinations from ?next=. */
    function safeNext() {
      const raw = new URLSearchParams(location.search).get('next');
      if (!raw) return '';
      try {
        const target = new URL(raw, location.origin);
        if (target.origin !== location.origin) return '';
        if (target.pathname === '/auth' || target.pathname === '/auth/' || target.pathname === '/auth.html') {
          return '';
        }
        return target.pathname + target.search + target.hash;
      } catch (error) {
        return '';
      }
    }

    function goHome() {
      if (redirecting) return;
      redirecting = true;
      if (redirectCountExceeded()) {
        redirecting = false;
        hideSplash();
        setBusy(false);
        showAlert(
          'We could not confirm your session. Please sign in again. If this keeps happening, check that this domain is authorized in Firebase Authentication.',
          'error'
        );
        return;
      }
      window.location.replace(safeNext() || APP_URL);
    }

    /*
     * Once Firebase reports a session, always navigate - even if the sign-in call
     * itself reports an error afterwards. A short delay lets the profile write start
     * without ever blocking the redirect.
     */
    function scheduleGoHome(delay = 800) {
      if (redirecting) return;
      clearTimeout(homeTimer);
      homeTimer = setTimeout(goHome, delay);
    }

    function showAlert(message, type = 'error') {
      const box = $('alertBox');
      if (!box) return;
      if (!message) {
        box.className = 'alert';
        box.textContent = '';
        return;
      }
      box.textContent = message;
      box.className = `alert show ${type}`;
    }

    function setMode(nextMode) {
      mode = nextMode;
      const isSignup = mode === 'signup';
      $('tabSignIn').classList.toggle('active', !isSignup);
      $('tabSignUp').classList.toggle('active', isSignup);
      $('tabSignIn').setAttribute('aria-selected', String(!isSignup));
      $('tabSignUp').setAttribute('aria-selected', String(isSignup));
      $('nameFieldWrap').classList.toggle('hidden', !isSignup);
      $('companyFieldWrap').classList.toggle('hidden', !isSignup);
      $('forgotBtn').classList.toggle('hidden', isSignup);
      $('authTitle').textContent = isSignup ? 'Create account' : 'Sign in';
      $('submitLabel').textContent = isSignup ? 'Create account' : 'Sign in';
      $('passwordInput').autocomplete = isSignup ? 'new-password' : 'current-password';
      showAlert('');
    }

    function setBusy(state, label = '') {
      busy = state;
      $('googleBtn').disabled = state;
      $('submitBtn').disabled = state;
      $('tabSignIn').disabled = state;
      $('tabSignUp').disabled = state;
      $('submitLabel').textContent = state
        ? label || (mode === 'signup' ? 'Creating…' : 'Signing in…')
        : mode === 'signup'
          ? 'Create account'
          : 'Sign in';
    }

    function friendlyError(error) {
      const map = {
        'auth/invalid-credential': 'Incorrect email or password.',
        'auth/user-not-found': 'No account found for this email.',
        'auth/wrong-password': 'Incorrect password.',
        'auth/email-already-in-use': 'Email already registered. Sign in instead.',
        'auth/weak-password': 'Password must be at least 6 characters.',
        'auth/invalid-email': 'Enter a valid email address.',
        'auth/too-many-requests': 'Too many attempts. Try again shortly.',
        'auth/popup-closed-by-user': 'Google sign-in was closed.',
        'auth/network-request-failed': 'Network error. Check your connection.',
        'auth/unauthorized-domain': 'Domain not authorized in Firebase Auth.',
        'auth/account-exists-with-different-credential':
          'This email already has an account. Sign in with the method you used originally.',
        'auth/operation-not-allowed': 'This sign-in method is not enabled for this project.',
        'auth/cancelled-popup-request': 'Sign-in was interrupted. Please try again.'
      };
      return map[error?.code] || error?.message || 'Authentication failed.';
    }

    async function saveUserProfileToRTDB(user, extras = {}) {
      const userRef = ref(db, `users/${user.uid}`);
      let existing = null;
      try {
        const snap = await get(userRef);
        if (snap.exists()) existing = snap.val();
      } catch (error) {}

      const primaryProvider =
        user.providerData?.[0]?.providerId || (user.email ? 'password' : 'unknown');
      const displayName = (
        extras.displayName ??
        user.displayName ??
        existing?.displayName ??
        (user.email ? user.email.split('@')[0] : 'User')
      ).trim();
      const company = (extras.company ?? existing?.company ?? '').trim();

      await update(userRef, {
        uid: user.uid,
        email: user.email || existing?.email || '',
        displayName,
        company,
        photoURL: user.photoURL || existing?.photoURL || '',
        provider: primaryProvider,
        providers: (user.providerData || []).map((provider) => provider.providerId).filter(Boolean),
        emailVerified: Boolean(user.emailVerified),
        createdAt: existing?.createdAt || serverTimestamp(),
        lastLoginAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    /* Never let the splash trap the page if Firebase is slow or offline. */
    splashTimer = setTimeout(() => {
      if (!redirecting) hideSplash();
    }, 7000);

    const onTabSignIn = () => setMode('signin');
    const onTabSignUp = () => setMode('signup');

    const onTogglePassword = () => {
      const input = $('passwordInput');
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      $('togglePw').setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      $('eyeIcon').innerHTML = hidden
        ? '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-3.17 4.52M1 1l22 22"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    };

    const onGoogleClick = async () => {
      if (busy) return;
      showAlert('');
      setBusy(true, 'Connecting…');
      try {
        const result = await signInWithPopup(auth, googleProvider);
        if (result?.user) {
          /* Profile sync is best-effort: it must never block navigation. */
          clearRedirectGuard();
          saveUserProfileToRTDB(result.user).catch(() => {});
          scheduleGoHome();
          return;
        }
        setBusy(false);
      } catch (error) {
        /* The session can exist even when the popup reports an error. */
        if (auth.currentUser) {
          scheduleGoHome(500);
          return;
        }
        if (
          error?.code === 'auth/popup-blocked' ||
          error?.code === 'auth/operation-not-supported-in-this-environment'
        ) {
          try {
            await signInWithRedirect(auth, googleProvider);
            return;
          } catch (redirectError) {
            if (auth.currentUser) {
              scheduleGoHome(500);
              return;
            }
            showAlert(friendlyError(redirectError), 'error');
            setBusy(false);
            return;
          }
        }
        showAlert(friendlyError(error), 'error');
        setBusy(false);
      }
    };

    const onFormSubmit = async (event) => {
      event.preventDefault();
      if (busy) return;
      showAlert('');

      const email = $('emailInput').value.trim();
      const password = $('passwordInput').value;
      const fullName = $('fullName').value.trim();
      const company = $('companyInput').value.trim();

      if (mode === 'signup' && !fullName) {
        showAlert('Enter your full name.', 'error');
        $('fullName').focus();
        return;
      }
      if (!email) {
        showAlert('Enter your email address.', 'error');
        $('emailInput').focus();
        return;
      }
      if (!password || (mode === 'signup' && password.length < 6)) {
        showAlert(
          mode === 'signup' ? 'Password must be at least 6 characters.' : 'Enter your password.',
          'error'
        );
        $('passwordInput').focus();
        return;
      }

      setBusy(true);
      try {
        let user = null;
        if (mode === 'signup') {
          const credential = await createUserWithEmailAndPassword(auth, email, password);
          user = credential.user;
          updateProfile(user, { displayName: fullName }).catch(() => {});
          saveUserProfileToRTDB(user, { displayName: fullName, company }).catch(() => {});
        } else {
          const credential = await signInWithEmailAndPassword(auth, email, password);
          user = credential.user;
          saveUserProfileToRTDB(user).catch(() => {});
        }
        if (user) {
          clearRedirectGuard();
          scheduleGoHome();
          return;
        }
        setBusy(false);
      } catch (error) {
        /* If the auth call established a session before failing, still enter the app. */
        if (auth.currentUser) {
          scheduleGoHome(500);
          return;
        }
        setBusy(false);
        showAlert(friendlyError(error), 'error');
      }
    };

    const onForgotClick = async () => {
      const email = $('emailInput').value.trim();
      if (!email) {
        showAlert('Enter your email above first.', 'error');
        $('emailInput').focus();
        return;
      }
      try {
        await sendPasswordResetEmail(auth, email);
        showAlert(`Reset link sent to ${email}.`, 'info');
      } catch (error) {
        showAlert(friendlyError(error), 'error');
      }
    };

    $('tabSignIn').addEventListener('click', onTabSignIn);
    $('tabSignUp').addEventListener('click', onTabSignUp);
    $('togglePw').addEventListener('click', onTogglePassword);
    $('googleBtn').addEventListener('click', onGoogleClick);
    $('authForm').addEventListener('submit', onFormSubmit);
    $('forgotBtn').addEventListener('click', onForgotClick);

    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          clearRedirectGuard();
          saveUserProfileToRTDB(result.user).catch(() => {});
          goHome();
        }
      })
      .catch((error) => {
        hideSplash();
        setBusy(false);
        showAlert(friendlyError(error), 'error');
      });

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        /* Any confirmed session always navigates - no gate, no stuck state. */
        clearRedirectGuard();
        saveUserProfileToRTDB(user).catch(() => {});
        scheduleGoHome();
      } else {
        hideSplash();
        setBusy(false);
        clearRedirectGuard();
      }
    });

    return () => {
      disposed = true;
      clearTimeout(splashTimer);
      clearTimeout(homeTimer);
      unsubscribe();
      $('tabSignIn')?.removeEventListener('click', onTabSignIn);
      $('tabSignUp')?.removeEventListener('click', onTabSignUp);
      $('togglePw')?.removeEventListener('click', onTogglePassword);
      $('googleBtn')?.removeEventListener('click', onGoogleClick);
      $('authForm')?.removeEventListener('submit', onFormSubmit);
      $('forgotBtn')?.removeEventListener('click', onForgotClick);
    };
  }, [firebaseConfig]);

  return (
    <>
      <div className="bg-canvas" aria-hidden="true">
        <div className="bg-orb orb-1" />
        <div className="bg-orb orb-2" />
        <svg className="bg-waves" viewBox="0 0 1440 900" preserveAspectRatio="none">
          <defs>
            <linearGradient id="aw1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#72dfbf" stopOpacity="0.18" />
              <stop offset="55%" stopColor="#5876ff" stopOpacity="0.11" />
              <stop offset="100%" stopColor="#9e87ff" stopOpacity="0.04" />
            </linearGradient>
            <linearGradient id="aw2" x1="1" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ee7c8" stopOpacity="0.13" />
              <stop offset="100%" stopColor="#283d8a" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path
            fill="url(#aw1)"
            d="M0,560 C240,455 440,670 720,575 C1000,480 1210,355 1440,445 L1440,900 L0,900 Z"
          />
          <path
            fill="url(#aw2)"
            d="M0,695 C320,765 560,550 860,645 C1140,730 1290,590 1440,635 L1440,900 L0,900 Z"
          />
          <path
            fill="none"
            stroke="#72dfbf"
            strokeOpacity="0.16"
            strokeWidth="1.5"
            d="M0,560 C240,455 440,670 720,575 C1000,480 1210,355 1440,445"
          />
          <path
            fill="none"
            stroke="#8ea2ff"
            strokeOpacity="0.13"
            strokeWidth="1.5"
            d="M0,695 C320,765 560,550 860,645 C1140,730 1290,590 1440,635"
          />
        </svg>
      </div>

      <div
        className="auth-splash"
        id="authSplash"
        role="status"
        aria-live="polite"
        aria-label="Checking session"
      >
        <div className="splash-logo" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
          </svg>
        </div>
        <div className="loader" aria-hidden="true" />
      </div>

      <main className="shell">
        <div className="two-panel">
          <section className="panel-visual" aria-hidden="true">
            <div className="brand">
              <div className="brand-icon">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
                </svg>
              </div>
              <span>
                CSR <span style={{ color: 'var(--mint)' }}>Studio</span>
              </span>
            </div>

            <div className="visual-center">
              <h1>
                Voice AI,
                <br />
                <span>simplified.</span>
              </h1>
              <p className="visual-subtitle">A modern workspace for seamless conversations.</p>
            </div>
          </section>

          <section className="panel-form" aria-live="polite">
            <div className="mobile-brand">
              <div className="brand-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
                </svg>
              </div>
              <span>
                CSR <span style={{ color: 'var(--mint)' }}>Studio</span>
              </span>
            </div>

            <div className="form-head">
              <h2 id="authTitle">Sign in</h2>
            </div>

            <div className="alert" id="alertBox" role="alert" />

            <div className="tabs" role="tablist" aria-label="Authentication mode">
              <button
                className="tab-btn active"
                id="tabSignIn"
                type="button"
                role="tab"
                aria-selected="true"
              >
                Sign in
              </button>
              <button
                className="tab-btn"
                id="tabSignUp"
                type="button"
                role="tab"
                aria-selected="false"
              >
                Sign up
              </button>
            </div>

            <button className="google-btn" id="googleBtn" type="button">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.27 14.29A7.21 7.21 0 0 1 4.9 12c0-.79.14-1.56.37-2.29V6.62H1.29A11.98 11.98 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l3.98-3.09z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>

            <div className="divider">
              <span>or</span>
            </div>

            <form className="form" id="authForm" noValidate>
              <div className="field hidden" id="nameFieldWrap">
                <label htmlFor="fullName">Full name</label>
                <input
                  id="fullName"
                  type="text"
                  autoComplete="name"
                  maxLength="80"
                  placeholder="Marco Reyes"
                />
              </div>

              <div className="field hidden" id="companyFieldWrap">
                <label htmlFor="companyInput">Company</label>
                <input
                  id="companyInput"
                  type="text"
                  autoComplete="organization"
                  maxLength="100"
                  placeholder="TechSolutions"
                />
              </div>

              <div className="field">
                <label htmlFor="emailInput">Email</label>
                <input
                  id="emailInput"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength="160"
                  placeholder="you@company.com"
                  required
                />
              </div>

              <div className="field">
                <div className="field-row">
                  <label htmlFor="passwordInput">Password</label>
                  <button className="link-btn" id="forgotBtn" type="button">
                    Forgot?
                  </button>
                </div>
                <div className="input-wrap">
                  <input
                    id="passwordInput"
                    type="password"
                    autoComplete="current-password"
                    minLength="6"
                    maxLength="128"
                    placeholder="••••••••"
                    required
                  />
                  <button
                    className="toggle-pw"
                    id="togglePw"
                    type="button"
                    aria-label="Show password"
                  >
                    <svg
                      id="eyeIcon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                </div>
              </div>

              <button className="primary-btn" id="submitBtn" type="submit">
                <span id="submitLabel">Sign in</span>
              </button>
            </form>
          </section>
        </div>
      </main>
    </>
  );
}
