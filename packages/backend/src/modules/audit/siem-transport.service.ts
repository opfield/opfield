import type { Env } from '@/config/env.js';
import type { SiemAuditEvent, siemDestinations } from '@/db/schema/siem.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { OutboundWebhookPolicyService } from '@/modules/settings/outbound-webhook-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
export interface SiemTestEvent {
  id: string;
  source: string;
  type: 'dev.opfield.audit.test.v1';
  time: string;
  test: true;
  data: SiemAuditEvent['data'];
}
export type SiemEvent = SiemAuditEvent | SiemTestEvent;
export interface SiemTransportResult {
  success: boolean;
  statusCode?: number;
  responseTimeMs: number;
  error?: string;
}
type SiemDestinationTransportConfig = Pick<
  typeof siemDestinations.$inferSelect,
  'url' | 'authType' | 'customHeaderName' | 'encryptedSecret'
>;
export class SiemTransportService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _env: Env,
    _cryptoService: CryptoService,
    _outboundWebhookPolicyService: OutboundWebhookPolicyService,
    _generalSettingsService?: GeneralSettingsService | undefined
  ) {}
  async validateEndpoint(_url: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async send(_destination: SiemDestinationTransportConfig, _events: SiemEvent[]): Promise<SiemTransportResult> {
    return commercialModuleUnavailable();
  }
}
