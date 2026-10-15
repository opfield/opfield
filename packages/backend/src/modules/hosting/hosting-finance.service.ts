import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { hostingOperations } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { User } from '@/types.js';
import type { HostingConnectorsService } from './hosting-connectors.service.js';
import { HostingProviderError } from './hosting-http.js';
import type { HostingOperationsService } from './hosting-operations.service.js';
import { assertHostingScope } from './hosting-permissions.js';
import type { HostingFinance, HostingInvoice } from './hosting-provider.types.js';

/** All public payment links are authenticated at the provider, not embedded HTML or tokenized API URLs. */
export function safeHostingInvoice(invoice: HostingInvoice): HostingInvoice {
  if (!invoice.url) return invoice;
  try {
    const url = new URL(invoice.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !['invapi.hostkey.com', 'cloud.digitalocean.com'].includes(url.hostname) ||
      (url.port && url.port !== '443') ||
      [...url.searchParams.keys()].some((key) => /token|secret|password|key/i.test(key))
    ) {
      return { ...invoice, url: undefined };
    }
    return invoice;
  } catch {
    return { ...invoice, url: undefined };
  }
}

export class HostingFinanceService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly connectors: HostingConnectorsService,
    private readonly operations: HostingOperationsService,
    private readonly auth: Pick<AuthService, 'getUserById'>
  ) {}

  async get(connectorId: string, user: User, cursor?: string): Promise<HostingFinance> {
    // Check before any network requests or generic account projection.
    assertHostingScope(user.scopes, 'hosting:billing:view', connectorId);
    const connector = await this.connectors.get(connectorId, user, true);
    if (connector.capabilities.finance !== true)
      throw new AppError(403, 'HOSTING_FINANCE_UNAVAILABLE', 'The provider credential does not grant billing access.');
    const adapter = this.connectors.adapter(connector);
    if (!adapter.finance)
      throw new AppError(
        409,
        'HOSTING_FINANCE_UNSUPPORTED',
        'This hosting integration does not expose account finances'
      );
    try {
      const result = await adapter.finance(cursor);
      return { ...result, invoices: result.invoices.map(safeHostingInvoice) };
    } catch (error) {
      if (error instanceof HostingProviderError && error.providerStatus === 403) {
        await this.connectors.revokeFinance(connector);
        throw new AppError(
          403,
          'HOSTING_FINANCE_UNAVAILABLE',
          'The provider credential does not grant billing access.'
        );
      }
      throw error;
    }
  }

  async invoice(connectorId: string, invoiceId: string, user: User) {
    assertHostingScope(user.scopes, 'hosting:billing:view', connectorId);
    const connector = await this.connectors.get(connectorId, user, true);
    const adapter = this.connectors.adapter(connector);
    if (!adapter.invoice)
      throw new AppError(409, 'HOSTING_INVOICE_UNSUPPORTED', 'This provider does not expose invoice detail');
    return safeHostingInvoice(await adapter.invoice(invoiceId));
  }

  async reconcileDue() {
    for (const due of await this.operations.due()) {
      if (due.action !== 'topup') continue;
      const row = await this.operations.claim(due.id);
      if (!row) continue;
      try {
        if (!row.connectorId) continue;
        const actor = row.actorId ? await this.auth.getUserById(row.actorId) : null;
        if (!actor || actor.isBlocked || actor.isDeleted)
          throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'Top-up owner no longer has access');
        assertHostingScope(actor.scopes, 'hosting:billing:view', row.connectorId);
        const connector = await this.connectors.get(row.connectorId, actor, true);
        const claimed = row;
        const adapter = this.connectors.adapter(connector, () => this.operations.renew(claimed));
        if (!adapter.invoice) throw new AppError(409, 'HOSTING_TOPUP_UNSUPPORTED', 'Top-up invoices are unavailable');
        // Top-ups were removed: a request saved before that and never sent fails instead of creating an invoice.
        // Invoices already created are still followed until they are paid or cancelled.
        if (row.phase === 'pending' && !row.dispatchStartedAt)
          throw new AppError(409, 'HOSTING_TOPUP_UNSUPPORTED', 'Top-up invoices are no longer created by Opfield');
        const invoiceId = row.providerOperation?.invoiceId;
        if (!invoiceId) {
          // Amount/time are not unique correlation. Never create a replacement invoice after uncertain dispatch.
          await this.operations.update(row, {
            phase: 'unknown',
            errorCode: 'HOSTING_INVOICE_OUTCOME_UNKNOWN',
            errorMessage:
              'The provider invoice creation outcome is unknown. No duplicate invoice will be created; inspect your provider account.',
          });
          continue;
        }
        const invoice = safeHostingInvoice(await adapter.invoice(invoiceId));
        if (invoice.status === 'paid') await this.operations.finish(row, 'ready', { invoice });
        else if (['cancelled', 'canceled', 'refunded'].includes(invoice.status))
          await this.operations.finish(
            row,
            'failed',
            { invoice },
            { code: 'HOSTING_INVOICE_CANCELLED', message: 'Provider invoice was cancelled or refunded' }
          );
        else
          await this.operations.update(row, {
            phase: 'awaiting_payment',
            result: { invoice },
            errorCode: null,
            errorMessage: null,
          });
      } catch (error) {
        if (error instanceof AppError && error.code === 'HOSTING_OPERATION_LEASE_LOST') continue;
        const [current] = await this.db.select().from(hostingOperations).where(eq(hostingOperations.id, row.id));
        const uncertain = current?.dispatchStartedAt || (error instanceof HostingProviderError && error.outcomeUnknown);
        try {
          await this.operations.update(row, {
            phase: uncertain ? 'unknown' : 'failed',
            errorCode: error instanceof AppError ? error.code : 'HOSTING_FINANCE_FAILED',
            errorMessage: error instanceof AppError ? error.message : 'Provider finance request failed',
          });
        } catch {
          /* A new owner must reconcile the persisted invoice ID. */
        }
      } finally {
        await this.operations.release(row, 30_000);
      }
    }
  }
}
