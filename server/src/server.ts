import { createApp } from './app.ts';
import { createDb } from './db.ts';
import { missingEnv } from './env.ts';

// Local development server. Port 4200 so it can run next to the Landlord (4000) and
// Study Scheduler (4100) APIs.
const missing = missingEnv();
if (missing.length > 0) {
  throw new Error(`Missing required environment variable(s): ${missing.join(', ')} (see server/.env.example)`);
}

const port = Number(process.env['PORT'] ?? 4200);
const db = createDb(process.env['DATABASE_URL'] ?? '');

createApp({ db }).listen(port, () => {
  console.info(`API listening on http://localhost:${port}`);
});
