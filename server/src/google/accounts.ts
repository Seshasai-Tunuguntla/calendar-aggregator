import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Db } from '../db.ts';
import type { GoogleIdentity } from './idToken.ts';

// What gets written to a Google connection after a successful sign-in or connect: encrypted
// tokens (from encryptedTokenFields) plus what Google told us about the account.
export interface ConnectionUpdate {
  encryptedAccessToken: string;
  accessTokenExpiresAt: Date;
  encryptedRefreshToken: string | null;
  tokenKeyVersion: number;
  grantedScopes: string[];
}

const google = (sub: string) => ({ provider_externalAccountId: { provider: 'GOOGLE' as const, externalAccountId: sub } });

// Signs in with a Google account. The account is found by Google's stable `sub` (not by email,
// which can change), on any of a user's connections, so signing in with a second connected
// account finds the same user. A first-time account creates a user.
export async function signInWithGoogle(
  db: Db,
  { identity, update, timeZone }: { identity: GoogleIdentity; update: ConnectionUpdate; timeZone: string },
): Promise<{ userId: string } | { error: 'email_in_use' }> {
  const data = { ...update, accountEmail: identity.email, status: 'ACTIVE' as const };

  const existing = await db.calendarConnection.findUnique({ where: google(identity.sub) });
  if (existing) {
    await db.calendarConnection.update({ where: { id: existing.id }, data });
    return { userId: existing.userId };
  }

  const base = handleBase(identity.name, identity.email);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const user = await db.user.create({
        data: {
          name: (identity.name ?? identity.email.split('@')[0] ?? 'Host').slice(0, 100),
          email: identity.email,
          handle: attempt === 0 ? base : `${base}-${randomSuffix()}`,
          timeZone,
          connections: { create: { provider: 'GOOGLE', externalAccountId: identity.sub, ...data } },
        },
      });
      return { userId: user.id };
    } catch (error) {
      const target = uniqueViolationTarget(error);
      if (target === null) throw error;
      if (target.includes('handle')) continue;
      if (target.includes('email')) return { error: 'email_in_use' };
      // Two first sign-ins with the same Google account at once: the other one created the user.
      if (target.includes('externalAccountId')) return signInWithGoogle(db, { identity, update, timeZone });
      throw error;
    }
  }
  throw new Error('Could not find a free handle');
}

// Adds a Google account to a signed-in user (e.g. work + personal), or refreshes its tokens.
export async function connectGoogleAccount(
  db: Db,
  { userId, identity, update }: { userId: string; identity: GoogleIdentity; update: ConnectionUpdate },
): Promise<{ ok: true } | { error: 'account_in_use' }> {
  const data = { ...update, accountEmail: identity.email, status: 'ACTIVE' as const };
  const existing = await db.calendarConnection.findUnique({ where: google(identity.sub) });
  if (existing && existing.userId !== userId) return { error: 'account_in_use' };
  if (existing) {
    await db.calendarConnection.update({ where: { id: existing.id }, data });
  } else {
    await db.calendarConnection.create({ data: { userId, provider: 'GOOGLE', externalAccountId: identity.sub, ...data } });
  }
  return { ok: true };
}

// A booking-link handle from the person's name, falling back to their email's local part:
// 'Sesha Sai Tunuguntla' -> 'sesha-sai-tunuguntla', 'José Núñez' -> 'jose-nunez'. At most 24
// characters, so a "-xxxxx" suffix still fits the 30-character limit when the handle is taken.
export function handleBase(name: string | undefined, email: string): string {
  for (const source of [name ?? '', email.split('@')[0] ?? '']) {
    const slug = source
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 24)
      .replace(/-+$/, '');
    if (slug.length >= 3) return slug;
  }
  return 'host';
}

function randomSuffix(): string {
  return randomBytes(4).readUInt32BE().toString(36).padStart(5, '0').slice(-5);
}

function uniqueViolationTarget(error: unknown): string[] | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  return ([] as unknown[]).concat(error.meta?.['target'] ?? []).map(String);
}
