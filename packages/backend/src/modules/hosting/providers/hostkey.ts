import { randomBytes } from 'node:crypto';
import { normalizeIp } from '@/lib/ip-cidr.js';
import { AppError } from '@/middleware/error-handler.js';
import { compareHostingDecimal, hostingDecimal } from '../hosting-decimal.js';
import { type HostingHttp, HostingHttpClient, HostingProviderError } from '../hosting-http.js';
import { hostingOsIdentity } from '../hosting-image-policy.js';
import { hostingLocationLabel } from '../hosting-location.js';
import {
  type HostingAccount,
  type HostingAccountSummary,
  type HostingActionRequest,
  type HostingAddress,
  type HostingCatalog,
  type HostingConnection,
  type HostingCreateRequest,
  type HostingFinance,
  type HostingInventory,
  type HostingInvoice,
  type HostingMoney,
  type HostingProviderAdapter,
  type HostingProviderOperation,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import { HostkeySnapshotsAdapter } from './hostkey-snapshots.js';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const rows = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(object) : []);
const string = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const numeric = (value: unknown): number | null =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const currencyCode = (value: unknown): string | null => (/^[A-Z]{3}$/.test(string(value)) ? string(value) : null);
const remoteIdentity = (value: unknown): string | undefined =>
  /^[1-9]\d*$/.test(string(value)) ? string(value) : undefined;
function money(value: unknown, currency: unknown, estimated = false): HostingMoney | null {
  const amount = string(value);
  const code = currencyCode(currency);
  return /^-?\d+(?:\.\d+)?$/.test(amount) && code ? { amount, currency: code, estimated } : null;
}

function explicitFailure(result: RecordValue): boolean {
  return [result.code, result.result].some(
    (value) => (numeric(value) !== null && Number(value) < 0) || /^(fail|failed|error)$/i.test(string(value))
  );
}

/** Classify provider diagnostics into fixed text; never echo passwords, tokens or guest scripts. */
function failureReason(result: RecordValue, secrets: string[] = []): string {
  const message = string(result.error) || string(result.message);
  if (/password|root_pass/i.test(message))
    return 'The root password was rejected. HOSTKEY requires 8–30 characters with uppercase, lowercase, a digit and one of % - _ +.';
  if (/preset|tariff|plan.*(?:invalid|not found)/i.test(message))
    return 'The requested tariff is unavailable or invalid. Check its provider name and region.';
  if (/insufficient|not enough|balance|credit|funds/i.test(message))
    return 'The account has insufficient funds or credit for this order.';
  if (/hostname/i.test(message)) return 'The VM hostname was rejected by HOSTKEY.';
  if (/out of stock|no.*(?:available|capacity)|unavailable.*(?:region|location)/i.test(message))
    return 'The selected configuration is unavailable in this region.';
  if (/os_id|os_template|operating system/i.test(message))
    return 'The selected OS is not available for this configuration.';
  if (/deploy_period|bill_period|billing period/i.test(message)) return 'The requested billing period was rejected.';
  // Preserve a bounded plain-text provider explanation instead of replacing every
  // unfamiliar rejection with code -1. Never pass through dumps, URLs or credentials.
  const diagnostic = message.trim();
  if (
    diagnostic.length > 0 &&
    diagnostic.length <= 300 &&
    !/[\p{Cc}\p{Cf}{}[\]<>\\=]/u.test(diagnostic) &&
    !/https?:|\b(?:token|secret|password|authorization|bearer|cookie|private.?key|user.?data)\b|-----BEGIN|[A-Za-z0-9_+/-]{24,}|[\w.+-]+@[\w.-]+/i.test(
      diagnostic
    ) &&
    !secrets.some((secret) => secret.length > 0 && diagnostic.includes(secret))
  )
    return `Provider says: ${diagnostic}`;
  const code = numeric(result.code) ?? numeric(result.result);
  return code !== null && Number.isSafeInteger(code)
    ? `Provider error code ${code}. Check the account features and selected configuration.`
    : 'Check the request parameters and available account features.';
}

export class HostkeyHostingAdapter implements HostingProviderAdapter {
  snapshots() {
    return new HostkeySnapshotsAdapter((module, action, parameters, mutation, allowNotReady) =>
      this.call(module, action, parameters, mutation, allowNotReady)
    );
  }
  readonly provider = 'hostkey' as const;
  constructor(
    private readonly connection: HostingConnection,
    private readonly http: HostingHttp = new HostingHttpClient(connection)
  ) {}

  private async call(
    module: string,
    action: string,
    parameters: Record<string, string | number | boolean | undefined> = {},
    mutation = false,
    allowNotReady = false,
    queryRead = false
  ): Promise<RecordValue> {
    const result = object(
      await this.http.request(`/${module}.php`, {
        method: queryRead ? 'GET' : 'POST',
        ...(queryRead ? { query: { action, ...parameters } } : { form: { action, ...parameters } }),
        readOnly: !mutation,
      })
    );
    if (
      explicitFailure(result) ||
      (!['OK', 'success'].includes(string(result.result)) &&
        !(allowNotReady && ['Not ready', 'Stage'].includes(string(result.result))))
    ) {
      // HOSTKEY reports failures in a JSON envelope. Its message can contain provider input, so only use it to
      // classify an explicitly documented access denial and never include it in the error returned by Gateway.
      const code = numeric(result.code) ?? numeric(result.result);
      const denied =
        code === -2 ||
        /\b(access denied|permission denied|forbidden|unauthorized|invalid (?:api )?token|session expired)\b/i.test(
          string(result.error) || string(result.message)
        );
      const status = denied ? 403 : 400;
      // An explicitly failed callback is a task outcome, not a transport ambiguity.
      const callbackUnavailable = /(?:callback|key).*(?:not found|expired|invalid)|invalid.*(?:callback|key)/i.test(
        string(result.error) || string(result.message)
      );
      if (allowNotReady && explicitFailure(result) && !denied && !callbackUnavailable) return result;
      // Unknown response formats are not proof that a paid write was rejected.
      const uncertain =
        mutation &&
        (!explicitFailure(result) ||
          Boolean(
            result.callback ||
              remoteIdentity(result.id) ||
              remoteIdentity(result.invoiceid ?? result.invoice_id) ||
              remoteIdentity(object(result.context).id)
          ));
      throw new HostingProviderError(
        status,
        uncertain,
        status === 403
          ? `HOSTKEY denied access to ${module}/${action}`
          : `HOSTKEY ${uncertain ? 'did not confirm' : 'rejected'} ${module}/${action}. ${failureReason(result, [
              this.connection.token,
              string(parameters.root_pass),
              string(parameters.post_install_script),
              string(parameters.ssh_key),
            ])}`
      );
    }
    return result;
  }

  private capabilities(canReadBilling = true) {
    const capabilities = hostingCapabilities({
      create: true,
      start: true,
      shutdown: true,
      reboot: true,
      delete: true,
      finance: canReadBilling,
      topup: canReadBilling,
    });
    if (!canReadBilling) {
      const unavailable = {
        available: false,
        reason: 'HOSTKEY key does not have billing access',
        reasonCode: 'permission_denied' as const,
      };
      capabilities.finance = unavailable;
      capabilities.topup = unavailable;
    }
    return capabilities;
  }

  private async client() {
    try {
      const result = await this.call('whmcs', 'get_client');
      const data = object(result.client);
      const id = string(data.id);
      if (!id) throw new HostingProviderError(502, false, 'HOSTKEY did not return a billing account identity');
      return {
        data,
        authority: `hostkey:${string(result.billing_location) || 'default'}:${id}`,
        name: string(data.companyname) || string(data.email) || id,
        canReadBilling: true,
      };
    } catch (error) {
      if (!(error instanceof HostingProviderError) || error.providerStatus !== 403) throw error;
    }

    // Server-scoped keys can lack WHMCS access, but auth/info exposes their stable billing identity.
    const info = await this.call('auth', 'info');
    const whmcsId = string(info.whmcs_id);
    const customerId = string(info.customer_id);
    if (!whmcsId && !customerId)
      throw new HostingProviderError(403, false, 'HOSTKEY key does not expose an account identity for VM access');
    if (whmcsId && customerId && whmcsId !== customerId)
      throw new HostingProviderError(502, false, 'HOSTKEY returned conflicting account identities');
    const id = whmcsId || customerId;
    const data = object(info.data);
    return {
      data: { id },
      authority: `hostkey:${string(info.whmcs_location) || 'default'}:${id}`,
      name: string(data.username) || string(data.user_id) || id,
      canReadBilling: false,
    };
  }

  async test(): Promise<HostingAccount> {
    const client = await this.client();
    await this.inventoryRows();
    return {
      authority: client.authority,
      name: client.name,
      capabilities: this.capabilities(client.canReadBilling),
    };
  }

  async catalog(): Promise<HostingCatalog> {
    const client = await this.client();
    const currency = currencyCode(client.data.currency_code);
    const presets = rows((await this.call('presets', 'list')).presets).filter((preset) => Number(preset.virtual) === 1);
    const os = rows((await this.call('os', 'list')).os_list);
    const locations = new Set<string>();
    const sizes = presets.map((preset) => {
      const placement = [
        ...new Set(
          (Array.isArray(preset.locations) ? preset.locations.map(string) : string(preset.locations).split(','))
            .map((location) => location.trim())
            .filter(Boolean)
        ),
      ];
      for (const location of placement) locations.add(location);
      const priceFor = (value: unknown) =>
        numeric(value) !== null && Number(value) >= 0 ? (money(value, currency, true) ?? undefined) : undefined;
      const prices = object(preset.price);
      const monthly =
        currency === 'USD'
          ? preset.monthly_usd
          : currency === 'EUR'
            ? preset.monthly_com
            : currency === 'RUB' || currency === 'RUR'
              ? preset.monthly_ru
              : undefined;
      // Live prices are region -> currency; -1 means use the base monthly price.
      const price = priceFor(prices[currency ?? '']) ?? priceFor(monthly);
      const locationPrices = Object.fromEntries(
        placement.flatMap((location) => {
          const regional = object(prices[location]);
          const quote = priceFor(regional[currency ?? ''] ?? (currency === 'RUB' ? regional.RUR : undefined)) ?? price;
          return quote ? [[location, quote]] : [];
        })
      );
      return {
        id: string(preset.id),
        name: string(preset.name),
        cpu: numeric(preset.cpu) ?? undefined,
        // HOSTKEY's live VPS catalog and panel express RAM and disk in GiB/GB.
        memoryMb: numeric(preset.ram) === null ? undefined : Number(preset.ram) * 1024,
        diskGb: numeric(preset.hdd) ?? undefined,
        architecture: 'x64' as const,
        locations: placement,
        price,
        locationPrices,
      };
    });
    return {
      locations: [...locations].map((id) => ({ id, name: hostingLocationLabel(id, undefined, id) })),
      sizes,
      images: os.map((image) => {
        const name = string(image.name ?? image.title);
        const identity =
          /^(ubuntu|debian|fedora)(?: server| cloud)?[ -]+(\d+(?:\.\d+)?)(?: lts)?(?:[ -]+(?:x64|amd64|x86_64|64[ -]?bit))?$/i.exec(
            name.trim()
          );
        // HOSTKEY's x86 VPS images omit architecture in plain names (e.g. Debian 12).
        // Explicit contradictory metadata must still fail closed.
        const architecture = image.architecture ?? image.arch;
        const x64 = architecture === undefined || /^(x64|amd64|x86_64)$/i.test(string(architecture));
        return {
          id: string(image.id),
          name,
          ...(identity && x64
            ? {
                operatingSystem: hostingOsIdentity(identity[1]!, identity[2]!),
                architecture: 'x64' as const,
              }
            : {}),
        };
      }),
    };
  }

  private normalize(detail: RecordValue, summary: RecordValue = {}): HostingResourceSnapshot {
    const server = { ...summary, ...object(detail.server_data) };
    const remoteId = string(server.id);
    if (!remoteId) throw new HostingProviderError(502, false, 'HOSTKEY returned a resource without an identity');
    if (summary.id !== undefined && remoteId !== string(summary.id))
      throw new HostingProviderError(502, false, 'HOSTKEY returned a different resource identity');
    const interfaces = rows(detail.interfaces);
    const addresses: HostingAddress[] = rows(detail.IP ?? server.ip).flatMap((entry) => {
      const ip = normalizeIp(string(entry.IP ?? entry.ip));
      const iface =
        interfaces.find((iface) => string(iface.mac).toLowerCase() === string(entry.MAC ?? entry.mac).toLowerCase()) ??
        interfaces.find((iface) => iface.IsMain === true || iface.IsMain === 1) ??
        interfaces[0];
      return ip
        ? [
            {
              ip,
              mac: string(entry.MAC ?? entry.mac ?? iface?.mac) || undefined,
              network: string(entry.vlan) || undefined,
              direct: true,
            },
          ]
        : [];
    });
    const hardware = object(server.hwconfig ?? detail.hardware);
    const macs = [
      ...new Set(
        [...interfaces.map((iface) => string(iface.mac)), ...addresses.map((address) => address.mac ?? '')]
          .map((mac) => mac.toLowerCase())
          .filter(Boolean)
          .sort()
      ),
    ];
    const uuid = string(server.uuid ?? object(server.vm).uuid);
    const created = string(server.created_at ?? server.date_created);
    const incarnation = uuid
      ? `uuid:${uuid}`
      : created
        ? `created:${created}`
        : macs.length
          ? `mac:${macs.join(',')}`
          : null;
    const hostnameTags = rows(detail.tags)
      .filter((tag) => tag.tag === 'hostname')
      .map((tag) => string(tag.value))
      .filter(Boolean);
    const tagNames = [...new Set(hostnameTags)];
    if (tagNames.length > 1) throw new HostingProviderError(502, false, 'HOSTKEY returned conflicting VM hostnames');
    const name = tagNames[0] || string(server.hostname) || remoteId;
    const condition = string(server.power_status ?? detail.power_status ?? server.Condition_Component).toLowerCase();
    const powerState = /^(power_on|on|running)$/.test(condition)
      ? 'running'
      : /^(power_off|off|stopped)$/.test(condition)
        ? 'stopped'
        : 'unknown';
    // Rental status "rent" is not evidence that the guest is running.
    return {
      remoteId,
      kind: 'vm',
      name,
      location: string(object(detail.location).dc_location ?? object(server.location).dc_location ?? server.location),
      powerState,
      cpu: numeric(hardware.cpu_count ?? hardware.cores),
      memoryMb: numeric(hardware.ram_mb),
      diskGb: numeric(hardware.disk_gb),
      addresses,
      incarnation,
      marker: /-(gw-[a-f0-9-]{36})$/.exec(name)?.[1],
      providerUrl: `https://invapi.hostkey.com/?id=${encodeURIComponent(remoteId)}`,
      capabilities: this.capabilities(),
      observedAt: new Date().toISOString(),
    };
  }

  private async inventoryRows(): Promise<RecordValue[]> {
    // Authentication already scopes this list to resources accessible to the key.
    // A WHMCS client ID is not an EQ account ID and silently filters out valid VMs.
    const result = await this.call('eq', 'list');
    if (!Array.isArray(result.servers))
      throw new HostingProviderError(502, false, 'HOSTKEY inventory response is incomplete');
    return result.servers.map((entry: unknown) => {
      const summary = typeof entry === 'object' ? object(entry) : { id: entry };
      const id = remoteIdentity(summary.id);
      if (!id) throw new HostingProviderError(502, false, 'HOSTKEY inventory contains an invalid resource identity');
      return { ...summary, id };
    });
  }

  async listResources(): Promise<HostingInventory> {
    await this.client();
    const servers = await this.inventoryRows();
    const resources: HostingResourceSnapshot[] = [];
    for (const server of servers) {
      const id = string(server.id);
      const detail = await this.call('eq', 'show', { id });
      const data = object(detail.server_data);
      // Hardware equipment and dedicated servers are not part of the VM integration.
      const virtual = data.virtual ?? server.virtual;
      const type = string(data.ref_tableName ?? data.type ?? server.type).toLowerCase();
      if (virtual === 0 || virtual === '0' || (type && !/^(vm|vps|vds|virtual|server)$/.test(type))) continue;
      resources.push(this.normalize(detail, server));
    }
    return { resources, complete: true, observedAt: new Date().toISOString() };
  }

  async getResource(remoteId: string): Promise<HostingResourceSnapshot | null> {
    // Only absence from a complete account inventory proves deletion. A type filter
    // or an incomplete show response must never remove a still-existing Gateway node.
    await this.client();
    const server = (await this.inventoryRows()).find((item) => string(item.id) === remoteId);
    if (!server) return null;
    return this.normalize(await this.call('eq', 'show', { id: remoteId }), server);
  }

  async create(input: HostingCreateRequest): Promise<HostingProviderOperation> {
    const catalog = await this.catalog();
    const size = catalog.sizes.find((size) => size.id === input.size && size.locations?.includes(input.location));
    if (!size || !catalog.images.some((image) => image.id === input.image))
      throw new AppError(
        400,
        'HOSTING_CONFIGURATION_UNAVAILABLE',
        'Selected HOSTKEY preset, location or OS is unavailable'
      );
    // The live traffic-plans endpoint reads selection filters from the query string.
    // Only a compatible, active, zero-surcharge plan can be selected without another quote.
    const traffic = await this.call(
      'traffic_plans',
      'list',
      {
        location: input.location,
        instance: input.size,
      },
      false,
      false,
      true
    );
    const currency = size.locationPrices?.[input.location]?.currency ?? size.price?.currency;
    const currencyId =
      currency === 'RUB' || currency === 'RUR' ? 1 : currency === 'USD' || currency === 'EUR' ? 0 : null;
    const plan = rows(traffic.traffic_plans)
      .filter(
        (plan) =>
          remoteIdentity(plan.id) &&
          Number(plan.active) === 1 &&
          numeric(plan.price) === 0 &&
          currencyId !== null &&
          numeric(plan.currency_id) === currencyId &&
          string(plan.locations)
            .split(',')
            .map((value) => value.trim())
            .includes(input.location)
      )
      .sort((a, b) => Number(a.id) - Number(b.id))[0];
    if (!plan)
      throw new AppError(
        409,
        'HOSTING_TRAFFIC_PLAN_UNAVAILABLE',
        'HOSTKEY did not return a compatible traffic plan without a surcharge; no VM was ordered'
      );
    if (!/^gw-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.marker))
      throw new AppError(400, 'HOSTING_MARKER_INVALID', 'Invalid Opfield VM identity marker');
    const prefix =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'opfield';
    const name = `${prefix.slice(0, 63 - input.marker.length - 1).replace(/-+$/g, '')}-${input.marker}`;
    const result = await this.call(
      'eq',
      'order_instance',
      {
        preset: size.name,
        location_name: input.location,
        os_id: input.image,
        hostname: name,
        root_pass: `${randomBytes(18).toString('base64url')}Aa1%`,
        // Single-disk VPS orders have no RAID selector in the provider panel.
        // Omit it: the live API rejects both PXE labels and numeric RAID values here.
        post_install_script: input.userData,
        ssh_key: input.sshPublicKey,
        deploy_period: 'monthly',
        traffic_plan: string(plan.id),
      },
      true
    );
    // Intentionally no "id" input: HOSTKEY interprets that as an OS reinstall.
    const order = { ...result, ...object(result.data) };
    const invoiceId = remoteIdentity(order.invoiceid ?? order.invoice_id);
    const id = string(order.callback) || null;
    const resourceId = remoteIdentity(order.id);
    return {
      id,
      resourceId,
      status:
        invoiceId || order.deploy_status === 'awaiting_payment' || order.redirect
          ? 'awaiting_payment'
          : id || resourceId
            ? 'running'
            : 'unknown',
      invoiceId,
    };
  }

  async action(resource: HostingResourceSnapshot, input: HostingActionRequest): Promise<HostingProviderOperation> {
    if (input.action === 'resize' || input.action === 'recover')
      throw new AppError(
        409,
        'HOSTING_ACTION_UNSUPPORTED',
        'This operation is not available through the verified HOSTKEY API'
      );
    if (input.action === 'delete') {
      await this.call(
        'whmcs',
        'request_cancellation',
        { id: resource.remoteId, cancellation_reason: input.reason ?? 'Explicit cancellation requested from Opfield' },
        true
      );
      return { id: `cancel:${resource.remoteId}`, resourceId: resource.remoteId, status: 'pending' };
    }
    const action = input.action === 'start' ? 'on' : input.action === 'shutdown' ? 'off' : 'reboot';
    const result = await this.call('eq', action, { id: resource.remoteId }, true);
    return {
      id: string(result.callback) || null,
      resourceId: resource.remoteId,
      status: string(result.callback) ? 'running' : 'unknown',
    };
  }

  async operation(id: string, resourceId?: string): Promise<HostingProviderOperation> {
    if (id.startsWith('cancel:')) {
      const exists = await this.getResource(id.slice(7));
      return { id, resourceId, status: exists ? 'pending' : 'succeeded' };
    }
    const result = await this.call('eq_callback', 'check', { key: id }, false, true);
    // HOSTKEY's own control panel treats OK as terminal and Not ready as still running.
    return {
      id,
      resourceId: remoteIdentity(object(result.context).id) || resourceId,
      status: explicitFailure(result)
        ? 'failed'
        : result.result === 'OK'
          ? 'succeeded'
          : result.result === 'Not ready' || result.result === 'Stage'
            ? 'running'
            : 'unknown',
      ...(explicitFailure(result)
        ? { error: `HOSTKEY task failed. ${failureReason(result, [this.connection.token])}` }
        : {}),
    };
  }

  private normalizeInvoice(value: unknown, currency?: string): HostingInvoice {
    const row = object(value);
    const id = string(row.id ?? row.invoiceid ?? row.invoice_id);
    if (!/^\d+$/.test(id)) throw new HostingProviderError(502, false, 'HOSTKEY returned an invalid invoice identity');
    const code = currencyCode(row.currency_code ?? row.currencycode ?? row.currency) ?? currency;
    return {
      id,
      status: string(row.status).toLowerCase() || 'unknown',
      total: money(row.total ?? row.amount, code),
      date: string(row.date) || null,
      dueDate: string(row.duedate ?? row.due_date) || null,
      url: `https://invapi.hostkey.com/?invoice=${id}`,
      resourceIds: rows(object(row.items).item)
        .map((item) => string(item.relid))
        .filter(Boolean),
    };
  }

  async accountSummary(resources: HostingResourceSnapshot[]): Promise<HostingAccountSummary> {
    const client = await this.client();
    const currency = currencyCode(client.data.currency_code);
    const balance = money(client.data.credit, currency);
    const months: Record<string, number> = {
      Monthly: 1,
      Quarterly: 3,
      'Semi-Annually': 6,
      Annually: 12,
      Biennially: 24,
      Triennially: 36,
    };
    let total = 0;
    let complete = Boolean(currency);
    for (const resource of resources) {
      try {
        const billing = await this.call('whmcs', 'get_billing_data', { id: resource.remoteId });
        if (['Cancelled', 'Terminated', 'Fraud'].includes(string(billing.billing_status))) continue;
        const period = months[string(billing.billing_cycle)];
        const amount = numeric(billing.billing_reccuring);
        const code = currencyCode(billing.currency_code ?? billing.currencycode ?? billing.currencysuffix);
        if (
          !['Active', 'Suspended'].includes(string(billing.billing_status)) ||
          !period ||
          amount === null ||
          amount < 0 ||
          code !== currency
        ) {
          complete = false;
          continue;
        }
        total += amount / period;
      } catch {
        complete = false;
      }
    }
    return {
      balance,
      monthlyExpenses:
        complete && currency && Number.isFinite(total)
          ? { amount: total.toFixed(2), currency, estimated: true, period: 'month' }
          : null,
      observedAt: new Date().toISOString(),
    };
  }

  async finance(): Promise<HostingFinance> {
    const client = await this.client();
    const currency = currencyCode(client.data.currency_code) ?? undefined;
    const invoiceResult = await this.call('whmcs', 'get_invoices');
    const transactions = await this.call('whmcs', 'transactions');
    const invoices = Array.isArray(invoiceResult.invoices)
      ? rows(invoiceResult.invoices)
      : rows(object(invoiceResult.invoices).invoice);
    return {
      balance: money(client.data.credit, currency),
      usage: null,
      invoices: invoices.map((row) => this.normalizeInvoice(row, currency)),
      transactions: rows(transactions.transactions).map((row) => ({
        id: string(row.id),
        date: string(row.date) || null,
        description: string(row.description),
        amount: money(row.amount ?? row.amountin, currency),
      })),
      observedAt: new Date().toISOString(),
      unavailableReason: money(client.data.credit, currency)
        ? undefined
        : 'HOSTKEY did not expose the authoritative account credit balance',
    };
  }

  async topup(amount: string, currency: string, marker: string): Promise<HostingInvoice> {
    const client = await this.client();
    if (currency !== currencyCode(client.data.currency_code))
      throw new AppError(409, 'HOSTING_CURRENCY_CHANGED', 'Account currency changed; review the top-up amount again');
    const result = await this.call(
      'whmcs',
      'create_addfunds',
      { amount, 'params[amount]': amount, 'params[description]': `Opfield hosting ${marker}`, subscribe: false },
      true
    );
    if (typeof result.invoice === 'number' || typeof result.invoice === 'string') {
      return {
        id: string(result.invoice),
        status: 'unpaid',
        total: { amount, currency, estimated: false },
        date: null,
        url: `https://invapi.hostkey.com/?invoice=${encodeURIComponent(string(result.invoice))}`,
      };
    }
    return this.normalizeInvoice(result.invoice, currency);
  }

  async invoice(id: string): Promise<HostingInvoice> {
    return this.normalizeInvoice(await this.orderInvoiceData(id));
  }

  private async orderInvoiceData(id: string): Promise<RecordValue> {
    if (!remoteIdentity(id)) throw new HostingProviderError(400, false, 'Invalid HOSTKEY invoice ID');
    const result = await this.call('whmcs', 'get_invoice', { invoice_id: id });
    const data = { ...result, ...object(result.data), ...object(result.invoice) };
    // Do not replace a contradictory provider identity with the requested ID.
    const identities = [data.id, data.invoiceid, data.invoice_id].filter((value) => value !== undefined);
    if (!identities.length || identities.some((value) => remoteIdentity(value) !== id))
      throw new HostingProviderError(502, false, 'HOSTKEY returned a different or missing invoice identity');
    return { ...data, id };
  }

  private invoiceMatchesOrder(data: RecordValue, marker: string): boolean {
    if (!/^gw-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(marker)) return false;
    const items = rows(object(data.items).item);
    // A UUID marker must be complete; never pay a topup, renewal or mixed invoice.
    const exactMarker = new RegExp(`(?:^|[^a-zA-Z0-9])${marker}(?![a-zA-Z0-9-])`, 'i');
    return (
      items.length === 1 &&
      string(items[0].type).toLowerCase() === 'hosting' &&
      exactMarker.test(string(items[0].description))
    );
  }

  async findOrderInvoice(marker: string): Promise<string | null> {
    const result = await this.call('whmcs', 'get_invoices', { limitstart: 0, limitnum: 100 });
    const data = { ...result, ...object(result.data) };
    const invoices = rows(Array.isArray(data.invoices) ? data.invoices : object(data.invoices).invoice);
    const total = numeric(data.totalresults);
    if (total === null || total !== invoices.length || total > 100)
      throw new HostingProviderError(
        502,
        false,
        'HOSTKEY invoice list is incomplete; order invoice cannot be identified safely'
      );
    const matches: string[] = [];
    for (const invoice of invoices) {
      const id = remoteIdentity(invoice.id ?? invoice.invoiceid);
      if (!id) throw new HostingProviderError(502, false, 'HOSTKEY returned an invalid invoice identity');
      const detail = await this.orderInvoiceData(id);
      if (this.invoiceMatchesOrder(detail, marker)) matches.push(id);
    }
    if (matches.length > 1)
      throw new HostingProviderError(
        409,
        false,
        'HOSTKEY returned multiple invoices for this order; no credit was applied'
      );
    return matches[0] ?? null;
  }

  private async checkedOrderInvoice(id: string, marker: string, quote: { amount: string; currency: string }) {
    const account = await this.client();
    const data = await this.orderInvoiceData(id);
    const invoice = this.normalizeInvoice(data);
    const clientId = remoteIdentity(account.data.id);
    const invoiceClientId = remoteIdentity(data.userid ?? data.clientid ?? object(data.client).id);
    if (!account.canReadBilling || !clientId || invoiceClientId !== clientId || !this.invoiceMatchesOrder(data, marker))
      throw new HostingProviderError(
        409,
        false,
        'HOSTKEY invoice does not belong exclusively to this Opfield order and account; no credit was applied'
      );
    const total = invoice.total;
    const totalComparison = total ? compareHostingDecimal(total.amount, quote.amount) : null;
    if (
      !total ||
      total.currency !== quote.currency ||
      currencyCode(account.data.currency_code) !== quote.currency ||
      totalComparison === null ||
      totalComparison > 0
    )
      throw new HostingProviderError(
        409,
        false,
        'HOSTKEY invoice currency or amount differs from the confirmed order; no credit was applied'
      );
    return { invoice, data, account };
  }

  async orderInvoice(id: string, marker: string, quote: { amount: string; currency: string }): Promise<HostingInvoice> {
    return (await this.checkedOrderInvoice(id, marker, quote)).invoice;
  }

  async payOrderInvoice(
    id: string,
    marker: string,
    quote: { amount: string; currency: string },
    beforePayment: (payment: { invoiceId: string; amount: string; currency: string }) => Promise<void>
  ): Promise<void> {
    const { invoice, data, account } = await this.checkedOrderInvoice(id, marker, quote);
    if (invoice.status === 'paid') return;
    if (invoice.status !== 'unpaid')
      throw new HostingProviderError(409, false, 'HOSTKEY order invoice is not unpaid; no credit was applied');
    const amount = hostingDecimal(string(data.balance));
    const credit = hostingDecimal(string(account.data.credit));
    const balanceComparison = amount && invoice.total ? compareHostingDecimal(amount, invoice.total.amount) : null;
    if (amount === null || amount === '0' || balanceComparison === null || balanceComparison > 0)
      throw new HostingProviderError(409, false, 'HOSTKEY invoice balance is invalid; no credit was applied');
    if (credit === null || compareHostingDecimal(credit, amount)! < 0)
      throw new HostingProviderError(409, false, 'HOSTKEY account credit is insufficient to pay this order invoice');
    await beforePayment({ invoiceId: id, amount, currency: quote.currency });
    // Same flat parameter contract as the official control panel. Never retry this mutation.
    await this.call('whmcs', 'apply_credit', { invoice_id: id, amount }, true);
  }
}
