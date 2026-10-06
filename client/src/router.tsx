import { Navigate, Outlet, createBrowserRouter, type RouteObject } from 'react-router';
import { AuthProvider } from './auth/AuthContext.tsx';
import { HostLayout } from './layout/HostLayout.tsx';
import { AccountPage } from './pages/AccountPage.tsx';
import { AvailabilityPage } from './pages/AvailabilityPage.tsx';
import { BookingPage } from './pages/BookingPage.tsx';
import { CalendarsPage } from './pages/CalendarsPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { ErrorPage } from './pages/ErrorPage.tsx';
import { EventTypesPage } from './pages/EventTypesPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ManageBookingPage } from './pages/ManageBookingPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

// Only the host's side asks who is signed in; guests' pages never call /api/auth/me.
function WithAuth() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

// Exported so tests can mount the same routes in a memory router.
export const routes: RouteObject[] = [
  {
    errorElement: <ErrorPage />,
    children: [
      {
        element: <WithAuth />,
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
        ],
      },
      // Guests
      { path: '/book/:handle/:slug', element: <BookingPage /> },
      { path: '/booking/:token', element: <ManageBookingPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
