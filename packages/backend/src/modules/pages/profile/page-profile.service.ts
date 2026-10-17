import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { UpdatePageProfileInput } from './page-profile.schemas.js';
import { LEGACY_PAGES_HOST_KEY } from '@/lib/legacy-compat.js';
export interface PageProfileRuntimeAdapter {
  apply(profile: { domain: string; certificateId: string; labelTemplate: string }): Promise<void>;
  disable(profile: { domain: string }): Promise<void>;
  cleanupNode?(profile: { domain: string; nodeId: string }): Promise<void>;
}
export class PageProfileService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService, _appUrl: string) {}
  setEventBus(_eventBus: EventBusService): void {}
  setRuntimeAdapter(_adapter: PageProfileRuntimeAdapter): void {}
  setLicensePolicyService(_policy: LicensePolicyService): void {}
  setGeneralSettings(_settings: GeneralSettingsService): void {}
  async isEnabled(): Promise<boolean> {
    return false;
  }
  async requireEnabled(): Promise<void> {
    return commercialModuleUnavailable();
  }
  async get(): Promise<
    | {
        enabled: boolean;
        status: string;
        id: string;
      }
    | {
        enabled: boolean;
        status: 'pending' | 'ready' | 'degraded' | 'disabled' | 'migration_pending' | 'capability_missing';
        createdAt: string;
        updatedAt: string;
        overrideAcknowledgedAt: string | null;
        domain: {
          id: string;
          domain: string;
          dnsStatus: 'pending' | 'unknown' | 'valid' | 'invalid';
          nginxNodeId: string | null;
        } | null;
        node: {
          id: string;
          displayName: string | null;
          hostname: string;
          status: 'pending' | 'error' | 'online' | 'offline';
          pagesCapable: boolean;
        } | null;
        certificate: {
          id: string;
          name: string;
          domainNames: string[];
          status: 'pending' | 'error' | 'active' | 'expired';
          notAfter: Date | null;
        } | null;
        isolation: {
          overrideRequired: boolean;
          overrideCurrent: boolean;
          opfieldHost: string;
          pagesHost: string;
          opfieldRegistrableDomain: string | null;
          pagesRegistrableDomain: string;
          same: boolean;
        } | null;
        id: string;
        domainId: string | null;
        nodeId: string | null;
        certificateId: string | null;
        labelTemplate: string;
        overrideSameRegistrableDomain: boolean;
        overrideComparedHosts: {
          [LEGACY_PAGES_HOST_KEY]: string;
          pagesHost: string;
        } | null;
        overrideAcknowledgedById: string | null;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
        createdById: string | null;
        updatedById: string | null;
      }
  > {
    return { enabled: false, status: 'disabled', id: 'default' };
  }
  async getOptions(): Promise<{
    domains: {
      isolation: {
        opfieldHost: string;
        pagesHost: string;
        opfieldRegistrableDomain: string | null;
        pagesRegistrableDomain: string;
        same: boolean;
      };
      id: string;
      domain: string;
      dnsStatus: 'pending' | 'unknown' | 'valid' | 'invalid';
      nginxNodeId: string | null;
    }[];
    nodes: {
      pagesCapable: boolean;
      id: string;
      displayName: string | null;
      hostname: string;
      status: 'pending' | 'error' | 'online' | 'offline';
    }[];
    certificates: {
      notAfter: string | null;
      id: string;
      name: string;
      domainNames: string[];
      status: 'pending' | 'error' | 'active' | 'expired';
    }[];
  }> {
    return commercialModuleUnavailable();
  }
  async configure(
    _input: UpdatePageProfileInput,
    _userId: string,
    _internal?: {
      allowDnsPending?: boolean;
      suppressPreviousNodeCleanup?: boolean;
    }
  ): Promise<
    | {
        enabled: boolean;
        status: string;
        id: string;
      }
    | {
        enabled: boolean;
        status: 'pending' | 'ready' | 'degraded' | 'disabled' | 'migration_pending' | 'capability_missing';
        createdAt: string;
        updatedAt: string;
        overrideAcknowledgedAt: string | null;
        domain: {
          id: string;
          domain: string;
          dnsStatus: 'pending' | 'unknown' | 'valid' | 'invalid';
          nginxNodeId: string | null;
        } | null;
        node: {
          id: string;
          displayName: string | null;
          hostname: string;
          status: 'pending' | 'error' | 'online' | 'offline';
          pagesCapable: boolean;
        } | null;
        certificate: {
          id: string;
          name: string;
          domainNames: string[];
          status: 'pending' | 'error' | 'active' | 'expired';
          notAfter: Date | null;
        } | null;
        isolation: {
          overrideRequired: boolean;
          overrideCurrent: boolean;
          opfieldHost: string;
          pagesHost: string;
          opfieldRegistrableDomain: string | null;
          pagesRegistrableDomain: string;
          same: boolean;
        } | null;
        id: string;
        domainId: string | null;
        nodeId: string | null;
        certificateId: string | null;
        labelTemplate: string;
        overrideSameRegistrableDomain: boolean;
        overrideComparedHosts: {
          [LEGACY_PAGES_HOST_KEY]: string;
          pagesHost: string;
        } | null;
        overrideAcknowledgedById: string | null;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
        createdById: string | null;
        updatedById: string | null;
      }
  > {
    return commercialModuleUnavailable();
  }
  async migrateDomainIngress(_domainIds: string[], _targetNodeId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cleanupMigratedSource(_domainIds: string[], _sourceNodeId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async disable(
    _userId: string | null,
    _reason?: 'user' | 'license_entitlement_loss'
  ): Promise<
    | {
        enabled: boolean;
        status: string;
        id: string;
      }
    | {
        enabled: boolean;
        status: 'pending' | 'ready' | 'degraded' | 'disabled' | 'migration_pending' | 'capability_missing';
        createdAt: string;
        updatedAt: string;
        overrideAcknowledgedAt: string | null;
        domain: {
          id: string;
          domain: string;
          dnsStatus: 'pending' | 'unknown' | 'valid' | 'invalid';
          nginxNodeId: string | null;
        } | null;
        node: {
          id: string;
          displayName: string | null;
          hostname: string;
          status: 'pending' | 'error' | 'online' | 'offline';
          pagesCapable: boolean;
        } | null;
        certificate: {
          id: string;
          name: string;
          domainNames: string[];
          status: 'pending' | 'error' | 'active' | 'expired';
          notAfter: Date | null;
        } | null;
        isolation: {
          overrideRequired: boolean;
          overrideCurrent: boolean;
          opfieldHost: string;
          pagesHost: string;
          opfieldRegistrableDomain: string | null;
          pagesRegistrableDomain: string;
          same: boolean;
        } | null;
        id: string;
        domainId: string | null;
        nodeId: string | null;
        certificateId: string | null;
        labelTemplate: string;
        overrideSameRegistrableDomain: boolean;
        overrideComparedHosts: {
          [LEGACY_PAGES_HOST_KEY]: string;
          pagesHost: string;
        } | null;
        overrideAcknowledgedById: string | null;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
        createdById: string | null;
        updatedById: string | null;
      }
  > {
    return commercialModuleUnavailable();
  }
  async disableForEntitlementLoss(): Promise<void> {}
  async reconcile(_allowDnsPending?: boolean): Promise<void> {}
  async assignImmutableHostname(_deploymentId: string): Promise<string | null> {
    return null;
  }
}
