import { createApp } from './app.ts';

// Local development server. Port 4200 so it can run next to the Landlord (4000) and
// Study Scheduler (4100) APIs.
const port = Number(process.env['PORT'] ?? 4200);

createApp().listen(port, () => {
  console.info(`API listening on http://localhost:${port}`);
});
