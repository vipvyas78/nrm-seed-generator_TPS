import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TenderDashboardPage } from './dashboard';
import { AppShell, AuthCallback, PackagesListPage, TenderPrepPage } from './pages';
import { CommunicationsPage } from './notifications';
import { PortalPage } from './portal';
import { ClientReplyPage } from './clientReply';
import './styles.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

// Served at both / (localhost:5175) and /tps/ (dev.novamerx.ai/tps, via the shared
// tunnel) from the same build — pick the router basename to match whichever the browser
// is actually on, rather than forcing /tps onto local-only usage.
const basename = window.location.pathname.startsWith('/tps') ? '/tps' : undefined;

export function Main() {
  return <QueryClientProvider client={client}>
    <BrowserRouter basename={basename}>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        {/* Public — a subcontractor opening an emailed link, not a BuildFlow user. Kept
            outside <AppShell/> for the same reason /auth/callback is: no BuildFlow
            branding or sign-in button belongs in front of an external visitor. */}
        <Route path="/respond/:token" element={<PortalPage />} />
        {/* The Client's own reply page. Outside AppShell, beside the portal, for the same
            reason: the viewer is not a BuildFlow user. */}
        <Route path="/client/:token" element={<ClientReplyPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<PackagesListPage />} />
          {/* Where BuildFlow's projects page links once a take-off is tendered, carrying its
              own package id: ?packageId=<bf package>. */}
          <Route path="/dashboard" element={<TenderDashboardPage />} />
          <Route path="/packages/:packageId/tender-prep" element={<TenderPrepPage />} />
          {/* Where a notification about a conversation goes when it belongs to no tender.
              An email nobody could attribute has no ITT Dispatch page to open, and this
              is the only place it is reachable. Deep-linked as ?thread=<id>. */}
          <Route path="/communications" element={<CommunicationsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>;
}

createRoot(document.getElementById('root')!).render(<Main />);
