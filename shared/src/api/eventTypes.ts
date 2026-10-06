import { z } from 'zod';

// The last part of a booking link, /book/:handle/:slug. The same rule as the database's CHECK.
export const eventTypeSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/,
    'The link can use lowercase letters, digits and hyphens (2 to 60 characters, not starting or ending with a hyphen)',
  );

// In the order a form shows them, so the first error reported is the first field's.
const fields = {
  title: z.string().trim().min(1, 'Give the event type a title').max(100, 'Titles can be at most 100 characters'),
  slug: eventTypeSlugSchema,
  description: z.string().trim().max(1000, 'Descriptions can be at most 1000 characters'),
  // The same ranges as the database's CHECK.
  durationMinutes: z.int().min(5, 'Events last 5 to 720 minutes').max(720, 'Events last 5 to 720 minutes'),
  slotStepMinutes: z.int().min(5, 'Start times are 5 to 240 minutes apart').max(240, 'Start times are 5 to 240 minutes apart'),
  active: z.boolean(),
};

// POST /api/event-types
export const createEventTypeRequestSchema = z.object({
  ...fields,
  description: fields.description.default(''),
  active: fields.active.default(true),
});
export type CreateEventTypeRequest = z.input<typeof createEventTypeRequestSchema>;

// PATCH /api/event-types/:id: any subset of the fields.
export const updateEventTypeRequestSchema = z.object(fields).partial();
export type UpdateEventTypeRequest = z.infer<typeof updateEventTypeRequestSchema>;

export const eventTypeSchema = z.object({
  id: z.uuid(),
  ...fields,
  // '/book/<handle>/<slug>': the public page guests open.
  bookingPath: z.string(),
});
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventTypesResponseSchema = z.object({ eventTypes: z.array(eventTypeSchema) });
export type EventTypesResponse = z.infer<typeof eventTypesResponseSchema>;
export const eventTypeResponseSchema = z.object({ eventType: eventTypeSchema });
export type EventTypeResponse = z.infer<typeof eventTypeResponseSchema>;
