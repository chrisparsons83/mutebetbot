import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../client.ts';
import { events, type EventRow } from '../schema.ts';

export type NewEvent = Omit<typeof events.$inferInsert, 'id' | 'at'>;

/** Appends to the audit trail. Call inside the same transaction as the change it records. */
export async function logEvent(db: DbOrTx, event: NewEvent): Promise<void> {
  await db.insert(events).values(event);
}

export async function eventsFor(db: DbOrTx, entity: EventRow['entity'], entityId: string): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(and(eq(events.entity, entity), eq(events.entityId, entityId)))
    .orderBy(asc(events.at), asc(events.id));
}
