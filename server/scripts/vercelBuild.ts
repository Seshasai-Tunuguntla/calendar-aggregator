import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type Env = Record<string, string | undefined>;

// Vercel's build command (vercel.json). Production migrates its database first, over Neon's direct
// connection (DATABASE_URL_UNPOOLED: migrations need a session, which the pooled connection
// doesn't keep), then the client is built. A preview never migrates anything unless it has a
// database of its own (PREVIEW_HAS_OWN_DATABASE=true, set together with a separate Neon branch),
// so a preview can't change the production schema.
export function migrationDatabaseUrl(env: Env): string | null {
  const ownDatabase = env['VERCEL_ENV'] === 'production' || (env['VERCEL_ENV'] === 'preview' && env['PREVIEW_HAS_OWN_DATABASE'] === 'true');
  if (!ownDatabase) return null;
  const url = env['DATABASE_URL_UNPOOLED'];
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is not set: migrations need the direct database connection');
  return url;
}

if (import.meta.main) {
  const url = migrationDatabaseUrl(process.env);
  if (url) {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'inherit',
    });
  } else {
    console.info(`No migrations for this ${process.env['VERCEL_ENV'] ?? 'local'} build: it has no database of its own.`);
  }
  execFileSync('npm', ['run', 'build', '--workspace', 'client'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: 'inherit' });
}
