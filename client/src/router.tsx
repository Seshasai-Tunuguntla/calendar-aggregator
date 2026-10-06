import { Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { HostLayout } from './layout/HostLayout.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { AvailabilityPage } from './pages/AvailabilityPage.tsx';
import { CalendarsPage } from './pages/CalendarsPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { ErrorPage } from './pages/ErrorPage.tsx';
import { EventTypesPage } from './pages/EventTypesPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

// Exported so tests can mount the same routes in a memory router.
export const routes: RouteObject[] = [
  {
    errorElement: <ErrorPage />,
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      { path: '/login', element: <LoginPage /> },
      {
        element: <HostLayout />,
        children: [
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/calendars', element: <CalendarsPage /> },
          { path: '/availability', element: <AvailabilityPage /> },
          { path: '/event-types', element: <EventTypesPage /> },
          { path: '/account', element: <AccountPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
