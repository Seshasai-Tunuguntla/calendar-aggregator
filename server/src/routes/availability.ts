import { Router, type RequestHandler } from 'express';
import { availabilitySchema, type Availability } from '@calendar-aggregator/shared';
import type { Db } from '../db.ts';
import { currentUser } from '../middleware/auth.ts';

export function availabilityRouter({ db, requireAuth }: { db: Db; requireAuth: RequestHandler }): Router {
  const router = Router();
  router.use(requireAuth);

  const load = async (userId: string): Promise<Availability> => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        timeZone: true,
        bufferBeforeMinutes: true,
        bufferAfterMinutes: true,
        minNoticeMinutes: true,
        horizonDays: true,
        maxPerDay: true,
        availabilityRules: {
          select: { weekday: true, startMinute: true, endMinute: true },
          orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
        },
      },
    });
    const { timeZone, availabilityRules: rules, ...settings } = user;
    return { timeZone, rules, settings };
  };

  router.get('/', async (req, res) => {
    res.json(await load(currentUser(req).id));
  });

  // Replaces the time zone, every rule and every setting at once, in one transaction, so the slot
  // algorithm never sees half an update. Validation (overlapping rules, rules crossing midnight,
  // settings ranges, unknown zones) happens in the shared schema, so the messages match the
  // client's.
  router.put('/', async (req, res) => {
    const userId = currentUser(req).id;
    const { timeZone, rules, settings } = availabilitySchema.parse(req.body);
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { timeZone, ...settings } }),
      db.availabilityRule.deleteMany({ where: { userId } }),
      db.availabilityRule.createMany({ data: rules.map((rule) => ({ ...rule, userId })) }),
    ]);
    res.json(await load(userId));
  });

  return router;
}
