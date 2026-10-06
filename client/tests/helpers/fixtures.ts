import type { BookingPageStatus, Calendar, Connection, EventType, HostBooking } from '@calendar-aggregator/shared';

export const id = (n: number) => `0190a5a4-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const status = (overrides: Partial<BookingPageStatus> = {}): BookingPageStatus => ({
  activeEventTypes: 1,
  hasHours: true,
  calendarProblem: null,
  ...overrides,
});

export const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: id(10),
  provider: 'GOOGLE',
  accountEmail: 'priya@example.com',
  status: 'ACTIVE',
  canDisconnect: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

export const booking = (overrides: Partial<HostBooking> = {}): HostBooking => ({
  id: id(20),
  status: 'CONFIRMED',
  start: '2026-10-13T08:30:00.000Z',
  end: '2026-10-13T09:00:00.000Z',
  guestName: 'Alex Kim',
  guestEmail: 'alex@example.com',
  guestTimeZone: 'Europe/London',
  stillOnCalendar: false,
  eventType: { id: id(30), title: '30-min call' },
  ...overrides,
});

export const eventType = (overrides: Partial<EventType> = {}): EventType => ({
  id: id(30),
  slug: '30-min-call',
  title: '30-min call',
  description: 'Talk it through.',
  durationMinutes: 30,
  slotStepMinutes: 30,
  active: true,
  bookingPath: '/book/priya/30-min-call',
  ...overrides,
});

export const calendar = (overrides: Partial<Calendar> = {}): Calendar => ({
  id: id(40),
  connectionId: id(10),
  accountEmail: 'priya@example.com',
  connectionStatus: 'ACTIVE',
  name: 'Priya',
  isPrimary: true,
  countsAsBusy: true,
  canCreateEvents: true,
  busyAccess: 'READABLE',
  ...overrides,
});
