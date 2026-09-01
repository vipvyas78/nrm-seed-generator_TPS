import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, AuthCallback, PackagesListPage, TenderPrepPage } from './pages';
import { PortalPage } from './portal';
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
        <Route element={<AppShell />}>
          <Route path="/" element={<PackagesListPage />} />
          <Route path="/packages/:packageId/tender-prep" element={<TenderPrepPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>;
}

createRoot(document.getElementById('root')!).render(<Main />);
