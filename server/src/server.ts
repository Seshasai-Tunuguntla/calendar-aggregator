import { createApp } from './app.ts';
import { createDb } from './db.ts';
import { missingEnv } from './env.ts';
import { googleAuthConfigFromEnv } from './google/config.ts';

// Local development server. Port 4200 so it can run next to the Landlord (4000) and
// Study Scheduler (4100) APIs.
const missing = missingEnv();
if (missing.length > 0) {
  throw new Error(`Missing required environment variable(s): ${missing.join(', ')} (see server/.env.example)`);
}

const port = Number(process.env['PORT'] ?? 4200);
const db = createDb(process.env['DATABASE_URL'] ?? '');
const googleConfig = googleAuthConfigFromEnv();

createApp({ db, google: googleConfig ? { config: googleConfig } : null }).listen(port, () => {
  console.info(`API listening on http://localhost:${port}`);
  if (!googleConfig) console.info('Google sign-in is off: see docs/google-setup.md. The demo works without it.');
});
