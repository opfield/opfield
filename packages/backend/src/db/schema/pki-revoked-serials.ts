import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { certificateAuthorities } from './certificate-authorities.js';

/**
 * A revoked PKI certificate that was deleted before it expired. Its CA keeps listing it on the CRL and OCSP keeps
 * answering "revoked" for its serial until notAfter: deleting a certificate must never make it valid again. The row
 * goes once the certificate would have expired.
 */
export const pkiRevokedSerials = pgTable(
  'pki_revoked_serials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caId: uuid('ca_id')
      .notNull()
      .references(() => certificateAuthorities.id, { onDelete: 'cascade' }),
    serialNumber: varchar('serial_number', { length: 255 }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull(),
    revocationReason: varchar('revocation_reason', { length: 50 }),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caSerialIdx: uniqueIndex('pki_revoked_serials_ca_serial_idx').on(table.caId, table.serialNumber),
    notAfterIdx: index('pki_revoked_serials_not_after_idx').on(table.notAfter),
  })
);
