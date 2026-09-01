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

export async function accessToken(): Promise<string | undefined> {
  return (await oidc?.getUser())?.access_token;
}

export async function signIn(): Promise<void> {
  if (!oidc) throw new Error('OIDC is not configured');
  await oidc.signinRedirect({ extraQueryParams: import.meta.env.VITE_OIDC_AUDIENCE ? { audience: import.meta.env.VITE_OIDC_AUDIENCE } : undefined });
}
