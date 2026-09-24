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
  return storedSessionToken() ?? (await oidc?.getUser())?.access_token;
}

export async function signIn(): Promise<void> {
  if (!oidc) throw new Error('OIDC is not configured');
  await oidc.signinRedirect({ extraQueryParams: import.meta.env.VITE_OIDC_AUDIENCE ? { audience: import.meta.env.VITE_OIDC_AUDIENCE } : undefined });
}
