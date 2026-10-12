// CA types
export type CAType = "root" | "intermediate";
export type CAStatus = "active" | "revoked" | "expired";
export type KeyAlgorithm = "rsa-2048" | "rsa-4096" | "ecdsa-p256" | "ecdsa-p384";

export interface CA {
  id: string;
  parentId: string | null;
  type: CAType;
  status: CAStatus;
  commonName: string;
  keyAlgorithm: KeyAlgorithm;
  serialNumber: string;
  certificatePem: string;
  subjectDn: string;
  issuerDn: string | null;
  pathLengthConstraint: number | null;
  maxValidityDays: number;
  notBefore: string;
  notAfter: string;
  ocspCertPem: string | null;
  crlNumber: number;
  lastCrlAt: string | null;
  crlDistributionUrl: string | null;
  ocspResponderUrl: string | null;
  caIssuersUrl: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  certCount: number;
  isSystem?: boolean;
  /** Folder of the CA's hierarchy: an intermediate reports the folder of its root CA. */
  folderId?: string | null;
  /** Order among sibling CAs (roots within a folder, intermediates under their parent). */
  sortOrder?: number;
}

// Certificate types
export type CertificateStatus = "active" | "revoked" | "expired";
export type CertificateType = "tls-server" | "tls-client" | "code-signing" | "email";
export type RevocationReason =
  | "unspecified"
  | "keyCompromise"
  | "caCompromise"
  | "affiliationChanged"
  | "superseded"
  | "cessationOfOperation"
  | "certificateHold";

export interface Certificate {
  id: string;
  caId: string;
  templateId: string | null;
  status: CertificateStatus;
  type: CertificateType;
  commonName: string;
  sans: string[];
  serialNumber: string;
  certificatePem: string;
  keyAlgorithm: KeyAlgorithm;
  subjectDn: string;
  issuerDn: string;
  notBefore: string;
  notAfter: string;
  csrPem: string | null;
  serverGenerated: boolean;
  keyUsage: string[];
  extKeyUsage: string[];
  revokedAt: string | null;
  revocationReason: string | null;
  issuedById: string;
  isSystem?: boolean;
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

// Template types
export interface SubjectDnFields {
  o?: string;
  ou?: string;
  l?: string;
  st?: string;
  c?: string;
  serialNumber?: string;
}

export interface CertificatePolicy {
  oid: string;
  qualifier?: string;
}

export interface CustomExtension {
  oid: string;
  critical: boolean;
  value: string;
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  certType: CertificateType;
  keyAlgorithm: KeyAlgorithm;
  validityDays: number;
  keyUsage: string[];
  extKeyUsage: string[];
  requireSans: boolean;
  sanTypes: string[];
  subjectDnFields: SubjectDnFields;
  crlDistributionPoints: string[];
  authorityInfoAccess: { ocspUrl?: string; caIssuersUrl?: string };
  certificatePolicies: CertificatePolicy[];
  customExtensions: CustomExtension[];
  createdById: string | null;
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

// Audit log
export interface AuditLogEntry {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName?: string | null;
  /** A plain line describing the entry, for actions that have one (the cloud link's). */
  summary?: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
  userAvatarUrl?: string | null;
}

// Alert types
export interface Alert {
  id: string;
  type: "expiry_warning" | "expiry_critical" | "ca_expiry" | "revocation";
  resourceType: string;
  resourceId: string;
  message: string;
  dismissed: boolean;
  createdAt: string;
}

// Request types
export interface CreateRootCARequest {
  commonName: string;
  keyAlgorithm: KeyAlgorithm;
  validityYears: number;
  pathLengthConstraint?: number;
  maxValidityDays?: number;
  /** Destination CA folder; needs pki:ca:edit there. */
  folderId?: string | null;
}

export interface CreateIntermediateCARequest {
  commonName: string;
  keyAlgorithm: KeyAlgorithm;
  validityYears: number;
  pathLengthConstraint?: number;
  maxValidityDays?: number;
}

export interface IssueCertificateRequest {
  caId: string;
  templateId?: string;
  type: CertificateType;
  commonName: string;
  sans: string[];
  keyAlgorithm: KeyAlgorithm;
  validityDays: number;
  /** End the certificate with the CA instead of failing when it would outlive the CA. */
  clampToCaValidity?: boolean;
  subjectDnFields?: SubjectDnFields;
  /** Destination certificate folder; needs pki:cert:folders:manage. */
  folderId?: string | null;
}

export interface IssueCertFromCSRRequest {
  caId: string;
  templateId?: string;
  type: CertificateType;
  csrPem: string;
  validityDays: number;
  overrideSans?: string[];
  folderId?: string | null;
}

/**
 * TLS certificate of a managed storage cluster or managed database and its
 * automatic renewal (GET /managed-storage/{id}/certificate,
 * GET /databases/managed/{id}/certificate).
 */
export interface ManagedCertificateStatus {
  ownerType: "managed_storage" | "managed_database";
  ownerId: string;
  certificate: {
    id: string;
    serialNumber: string;
    notBefore: string;
    notAfter: string;
    daysRemaining: number;
    sans: string[];
  } | null;
  renewal: {
    /** idle | delivering | awaiting_reload | waiting_for_daemon | ca_limited | failed */
    state: string;
    reason: string | null;
    due: boolean;
    dueReason: string | null;
    urgent: boolean;
    hotReloadSupported: boolean;
    skipReason: string | null;
    attempts: number;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    deliveredAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastMethod: string | null;
    lastRestarted: boolean;
    pendingSerial: string | null;
  };
}
