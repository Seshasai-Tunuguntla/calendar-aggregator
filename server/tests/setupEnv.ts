import { loadTestEnv } from './testDatabase.ts';

// Runs in every test file's worker before the file itself, so createApp and the database helpers
// see the test settings.
loadTestEnv();
