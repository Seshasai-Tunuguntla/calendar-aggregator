import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
// The heading serif, self-hosted from the npm package: Latin, weight 600 only (about 18 kB woff2),
// font-display: swap. No requests to a font service.
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet, imported for its side effect
import '@fontsource/fraunces/latin-600.css';
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet, imported for its side effect
import './styles/tokens.css';
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet, imported for its side effect
import './styles/app.css';
import { router } from './router.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element in index.html');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
