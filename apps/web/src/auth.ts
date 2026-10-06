import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

const authority = import.meta.env.VITE_OIDC_AUTHORITY;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;

// Mounted at both / (localhost) and /tps/ (dev.novamerx.ai/tps) from the same build —
// mirrors the basename logic in main.tsx so the OIDC redirect lands back on whichever
// prefix the user actually started from.
const basePath = window.location.pathname.startsWith('/tps') ? '/tps' : '';

export const oidc = authority && clientId
  ? new UserManager({
      authority,
      client_id: clientId,
      redirect_uri: `${window.location.origin}${basePath}/auth/callback`,
      post_logout_redirect_uri: `${window.location.origin}${basePath}`,
      response_type: 'code',
      scope: 'openid profile email',
      userStore: new WebStorageStateStore({ store: window.sessionStorage })
    })
  : undefined;

/**
 * Issue #37's local session token — read from the SAME key BuildFlow writes.
 *
 * Two shells on one origin per deployment (`dev.novamerx.ai` and `dev.novamerx.ai/tps`),
 * so a person who signs in to BuildFlow is signed in here too, which is what a single
 * identity store means in practice. TPS never writes this key: it verifies the session,
 * and BuildFlow owns signing in, signing out and changing a password.
 *
 * On localhost the two run on different ports and therefore different origins, so the
 * token does not carry across in development. That is a property of the dev setup, not
 * of the design — `VITE_DEV_SUBJECT` is what covers it, as it does today.
 */
const SESSION_TOKEN_KEY = 'buildflow.session';

export function storedSessionToken(): string | undefined {
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_KEY) ?? undefined;
  } catch {
    // Private mode or a site-data policy. Falling through to OIDC or the dev headers is
    // better than a shell that will not render.
    return undefined;
  }
}

export async function accessToken(): Promise<string | undefined> {
  return storedSessionToken() ?? (await sessionFromBuildflow()) ?? (await oidc?.getUser())?.access_token;
}

export function clearStoredSessionToken(): void {
  try { window.sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch { /* nothing to clear */ }
}

/**
 * Ask a signed-in BuildFlow tab for its session over a same-origin BroadcastChannel. The old
 * route — inheriting sessionStorage through the opener — depends on browser rules (target=_blank
 * is noopener by default, COOP severs openers) and a bookmark has no opener at all. The copy is
 * kept in THIS tab's sessionStorage, so it ends with the tab like the original does.
 */
let pendingHandoff: Promise<string | undefined> | undefined;
function sessionFromBuildflow(): Promise<string | undefined> {
  if (typeof BroadcastChannel === 'undefined' || !sharesOriginWithBuildflow()) return Promise.resolve(undefined);
  pendingHandoff ??= new Promise<string | undefined>((resolve) => {
    const channel = new BroadcastChannel('buildflow-session');
    const done = (token?: string) => { clearTimeout(timer); channel.close(); pendingHandoff = undefined; resolve(token); };
    const timer = setTimeout(() => done(undefined), 600);
    channel.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'session' || typeof event.data.token !== 'string') return;
      try { window.sessionStorage.setItem(SESSION_TOKEN_KEY, event.data.token); } catch { /* held in memory only */ }
      done(event.data.token);
    };
    channel.postMessage({ type: 'need-session' });
  });
  return pendingHandoff;
}

export function loginUrl(): string {
  return `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}

// BuildFlow signed out in another tab: this tab's copy is dead, so leave rather than let the
// next click fail with a bare 401.
if (typeof BroadcastChannel !== 'undefined' && basePath === '/tps') {
  const signedOut = new BroadcastChannel('buildflow-session');
  signedOut.onmessage = (event: MessageEvent) => {
    if (event.data?.type !== 'signed-out') return;
    clearStoredSessionToken();
    window.location.replace(loginUrl());
  };
}

export async function signIn(): Promise<void> {
  if (!oidc) throw new Error('OIDC is not configured');
  await oidc.signinRedirect({ extraQueryParams: import.meta.env.VITE_OIDC_AUDIENCE ? { audience: import.meta.env.VITE_OIDC_AUDIENCE } : undefined });
}

/**
 * True where TPS is mounted under /tps on BuildFlow's own origin, so BuildFlow's /login is
 * reachable and its session would be visible here. On localhost (separate ports) it is not.
 */
export function sharesOriginWithBuildflow(): boolean {
  return basePath === '/tps' && !(import.meta.env.VITE_DEV_SUBJECT && import.meta.env.VITE_DEV_ORGANIZATION);
}
