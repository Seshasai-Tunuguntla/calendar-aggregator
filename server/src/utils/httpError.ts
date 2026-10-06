// An error with an HTTP status and a message that is safe to show the client.
// Handlers and helpers throw it (e.g. `throw new HttpError(409, 'That time was just taken')`)
// and the central error handler turns it into a JSON response. Usually 4xx; 503 for "a service we
// depend on is down, try again later", which the client should show rather than a generic error.
export class HttpError extends Error {
  readonly status: number;
  // Same flag the http-errors package (used by express.json()) sets on client-safe errors.
  readonly expose = true;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
