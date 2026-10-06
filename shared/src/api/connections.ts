import { z } from 'zod';

// A calendar account connected to the signed-in host. Tokens never leave the server.
export const connectionSchema = z.object({
  id: z.uuid(),
  provider: z.enum(['GOOGLE', 'DEMO']),
  accountEmail: z.string(),
  // NEEDS_RECONNECT: Google access expired or was revoked; the UI shows "Reconnect Google".
  status: z.enum(['ACTIVE', 'NEEDS_RECONNECT']),
  // False for the demo calendar and for the last Google account (it's how the host signs in).
  canDisconnect: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Connection = z.infer<typeof connectionSchema>;

// GET /api/connections
export const connectionsResponseSchema = z.object({ connections: z.array(connectionSchema) });
export type ConnectionsResponse = z.infer<typeof connectionsResponseSchema>;

// DELETE /api/connections/:id. revokedAtGoogle is false if Google couldn't be reached; the
// tokens are deleted from our database either way.
export const disconnectResponseSchema = z.object({ revokedAtGoogle: z.boolean() });
export type DisconnectResponse = z.infer<typeof disconnectResponseSchema>;
