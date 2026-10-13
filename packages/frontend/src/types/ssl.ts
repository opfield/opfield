import type { AppMembershipRef } from "./apps";

// SSL Certificate Types
export type SSLCertType = "acme" | "upload" | "internal";
export type SSLCertStatus = "active" | "expired" | "pending" | "error";
export type ACMEChallengeType = "http-01" | "dns-01";
export type CertificateDistributionStatus =
  | "not_deployed"
  | "ready"
  | "pending"
  | "failed"
  | "daemon_update_required";

export interface CertificateDistributionState {
  status: CertificateDistributionStatus;
  replicaCount: number;
  readyReplicaCount: number;
  lastVerifiedAt: string | null;
  error: string | null;
  replicas?: Array<{
    nodeId: string;
    nodeName: string;
    nodeSlug: string | null;
    status: Exclude<CertificateDistributionStatus, "not_deployed">;
    lastVerifiedAt: string | null;
    error: string | null;
  }>;
}

export interface SSLCertificate {
  /** Set when the certificate is a member of an app environment. */
  app?: AppMembershipRef | null;
  id: string;
  name: string;
  type: SSLCertType;
  domainNames: string[];
  acmeProvider: string | null;
  acmeChallengeType: ACMEChallengeType | null;
  acmePendingOperation: "issue" | "renewal" | null;
  acmePendingChallenges: DNSChallenge[] | null;
  internalCertId: string | null;
  notBefore: string | null;
  notAfter: string | null;
  autoRenew: boolean;
  autoRenewProvider: "cloudflare" | null;
  autoRenewDnsBindings: Array<{
    domain: string;
    connectorId: string;
    connectorName: string;
    zoneId: string;
    zoneName: string;
  }> | null;
  autoRenewDisabledReason: string | null;
  autoRenewDisabledAt: string | null;
  lastRenewedAt: string | null;
  renewalError: string | null;
  status: SSLCertStatus;
  distribution?: CertificateDistributionState;
  isSystem?: boolean;
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequestACMECertRequest {
  domains: string[];
  challengeType: ACMEChallengeType;
  provider?: string;
  dnsProvider?: "cloudflare";
  autoRenew?: boolean;
  folderId?: string | null;
}

export interface UploadCertRequest {
  name: string;
  folderId?: string | null;
  certificatePem: string;
  privateKeyPem: string;
  chainPem?: string;
}

export interface LinkInternalCertRequest {
  internalCertId: string;
  name?: string;
  folderId?: string | null;
}

export interface DNSChallenge {
  domain: string;
  recordName: string;
  recordValue: string;
}

export interface SSLCertificateOperationResult {
  certificate: SSLCertificate;
  status: "issued" | "pending_dns_verification";
  challenges?: DNSChallenge[];
}
