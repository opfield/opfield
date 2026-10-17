import type { AIToolDefinition } from './ai.types.js';

export const PKI_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'audit_system_pki_leaves',
    description:
      'Explicit read-only audit of leaves issued by Opfield system CAs. System PKI is otherwise hidden. Reports persisted lifecycle evidence and never revokes, deletes, exports keys, or cleans certificates.',
    parameters: {
      type: 'object',
      properties: { caId: { type: 'string', description: 'Optional system CA UUID to audit' } },
    },
    destructive: false,
    category: 'PKI - System Audit',
    requiredScope: 'admin:details:certificates',
    invalidateStores: [],
  },
  {
    name: 'list_cas',
    description:
      'List all Certificate Authorities with their status, type, and hierarchy. Returns id, commonName, type (root/intermediate), status, notBefore, notAfter, parentId, folderId and sortOrder (an intermediate reports the folder of its root CA; list_resource_folders with pki_cas names the folders). CAs are listed for pki:ca:view (broad or on that CA) or a per-CA pki:cert:issue grant.',
    parameters: {
      type: 'object',
      properties: {
        showSystem: { type: 'boolean', description: 'Include Opfield system CAs; needs admin:details:certificates' },
      },
    },
    destructive: false,
    category: 'PKI - Certificate Authorities',
    requiredScope: 'pki:ca:view',
    invalidateStores: [],
  },
  {
    name: 'get_ca',
    description: 'Get detailed information about a specific CA by ID, including its signing certificate details.',
    parameters: {
      type: 'object',
      properties: {
        caId: { type: 'string', description: 'CA UUID' },
      },
      required: ['caId'],
    },
    destructive: false,
    category: 'PKI - Certificate Authorities',
    requiredScope: 'pki:ca:view',
    invalidateStores: [],
  },
  {
    name: 'create_root_ca',
    description: 'Create a new root Certificate Authority. Returns the created CA.',
    parameters: {
      type: 'object',
      properties: {
        commonName: { type: 'string', description: 'CA common name (e.g., "My Root CA")' },
        keyAlgorithm: {
          type: 'string',
          enum: ['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384'],
          description: 'Key algorithm',
        },
        validityYears: { type: 'number', description: 'Validity period in years (1-30)' },
        pathLengthConstraint: {
          type: 'number',
          description:
            'Max depth of CA chain below this CA. 0 = can only issue end-entity certs, 1 = one level of intermediates, etc. Omit for unlimited.',
        },
        maxValidityDays: { type: 'number', description: 'Max validity for issued certs in days (default: 825)' },
        folderId: {
          type: ['string', 'null'],
          description:
            'Destination CA folder UUID (list_resource_folders pki_cas); needs pki:ca:edit on that folder, like moving the root CA there.',
        },
      },
      required: ['commonName', 'keyAlgorithm', 'validityYears'],
    },
    destructive: true,
    category: 'PKI - Certificate Authorities',
    requiredScope: 'pki:ca:create:root',
    invalidateStores: ['ca'],
  },
  {
    name: 'create_intermediate_ca',
    description: 'Create an intermediate CA signed by a parent CA.',
    parameters: {
      type: 'object',
      properties: {
        parentCaId: { type: 'string', description: 'Parent CA UUID' },
        commonName: { type: 'string', description: 'CA common name' },
        keyAlgorithm: {
          type: 'string',
          enum: ['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384'],
          description: 'Key algorithm',
        },
        validityYears: { type: 'number', description: 'Validity period in years' },
        pathLengthConstraint: {
          type: 'number',
          description:
            'Max depth of CA chain below this CA. 0 = can only issue end-entity certs. Omit to auto-derive from parent.',
        },
        maxValidityDays: { type: 'number', description: 'Max validity for issued certs in days' },
        folderId: {
          type: ['string', 'null'],
          description:
            'Optional. An intermediate CA is listed in the folder of its root CA; when given, it must be that folder (move the root CA to change it).',
        },
      },
      required: ['parentCaId', 'commonName', 'keyAlgorithm', 'validityYears'],
    },
    destructive: true,
    category: 'PKI - Certificate Authorities',
    requiredScope: 'pki:ca:create:intermediate',
    invalidateStores: ['ca'],
  },
  {
    name: 'delete_ca',
    description:
      'Permanently delete a Certificate Authority. Cannot be undone. The CA must have no certificates (delete them first) and no child CAs. Its CRL goes with it: revoked certificates deleted before they expired (keptOnCrlUntil) are then on no CRL, and the answer counts them (droppedFromCrl, note). Remove the CA from trust stores after deleting it.',
    parameters: {
      type: 'object',
      properties: {
        caId: { type: 'string', description: 'CA UUID to delete' },
      },
      required: ['caId'],
    },
    destructive: true,
    category: 'PKI - Certificate Authorities',
    requiredScope: 'pki:ca:revoke:root',
    invalidateStores: ['ca'],
  },
  {
    name: 'manage_ca',
    description:
      'Manage Certificate Authorities beyond create/delete. Operations: update (CRL distribution URL, CA issuers URL, max issued validity; needs pki:ca:edit on the CA), revoke (revokes the CA and its subordinate CAs; needs pki:ca:revoke:<type>), export_key (PKCS#12 of the CA private key and certificate protected by passphrase, returned base64; needs pki:ca:export on the CA and is audited).',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['update', 'revoke', 'export_key'] },
        caId: { type: 'string' },
        crlDistributionUrl: { type: ['string', 'null'] },
        caIssuersUrl: { type: ['string', 'null'] },
        maxValidityDays: { type: 'number' },
        reason: { type: 'string', description: 'Revocation reason for revoke' },
        passphrase: { type: 'string', description: 'PKCS#12 passphrase for export_key (at least 8 characters)' },
      },
      required: ['operation', 'caId'],
    },
    destructive: true,
    category: 'PKI - Certificate Authorities',
    requiredScope: 'pki:ca:edit',
    invalidateStores: ['ca'],
    historyRetention: { mode: 'never_full' },
  },
  {
    name: 'list_certificates',
    description:
      'List PKI certificates with optional filters. Returns paginated results with id, commonName, status, type, caId, notBefore, notAfter, folderId, sortOrder (list_resource_folders with pki_certificates names the folders).',
    parameters: {
      type: 'object',
      properties: {
        caId: { type: 'string', description: 'Filter by CA UUID' },
        status: { type: 'string', enum: ['active', 'revoked', 'expired'], description: 'Filter by status' },
        type: { type: 'string', enum: ['tls-server', 'tls-client', 'code-signing', 'email'] },
        search: { type: 'string', description: 'Search by common name' },
        showSystem: {
          type: 'boolean',
          description: 'Include certificates of Opfield system CAs; needs admin:details:certificates',
        },
        sortBy: { type: 'string', enum: ['commonName', 'createdAt', 'notAfter', 'type'] },
        sortOrder: { type: 'string', enum: ['asc', 'desc'] },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
    },
    destructive: false,
    category: 'PKI - Certificates',
    requiredScope: 'pki:cert:view',
    invalidateStores: [],
  },
  {
    name: 'get_certificate',
    description: 'Get detailed information about a specific certificate by ID.',
    parameters: {
      type: 'object',
      properties: {
        certificateId: { type: 'string', description: 'Certificate UUID' },
      },
      required: ['certificateId'],
    },
    destructive: false,
    category: 'PKI - Certificates',
    requiredScope: 'pki:cert:view',
    invalidateStores: [],
  },
  {
    name: 'issue_certificate',
    description:
      'Issue a new PKI certificate from a CA. Returns the certificate. A TLS server certificate serves an ingress route either directly (internalCertificateId on create_route or update_route) or after link_internal_cert imports it as an SSL certificate (its sslCertificateId).',
    parameters: {
      type: 'object',
      properties: {
        caId: { type: 'string', description: 'Issuing CA UUID' },
        commonName: { type: 'string', description: 'Certificate common name (e.g., "server.example.com")' },
        keyAlgorithm: {
          type: 'string',
          enum: ['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384'],
          description: 'Key algorithm',
        },
        validityDays: { type: 'number', description: 'Validity in days' },
        clampToCaValidity: {
          type: 'boolean',
          description:
            'When the requested validity would outlive the issuing CA, end the certificate with the CA instead of failing with VALIDITY_EXCEEDS_CA.',
        },
        type: {
          type: 'string',
          enum: ['tls-server', 'tls-client', 'code-signing', 'email'],
          description: 'Certificate type. Use tls-server for web/SSL certificates.',
        },
        sans: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Subject Alternative Names as plain values WITHOUT type prefix. Examples: "example.com", "*.example.com", "10.0.0.1". Do NOT use "DNS:" or "IP:" prefixes.',
        },
        templateId: { type: 'string', description: 'Optional template UUID to use' },
        folderId: {
          type: ['string', 'null'],
          description:
            'Destination certificate folder UUID (list_resource_folders pki_certificates); needs pki:cert:folders:manage.',
        },
        subjectDnFields: {
          type: 'object',
          properties: {
            o: { type: 'string', description: 'Organization' },
            ou: { type: 'string', description: 'Organizational Unit' },
            c: { type: 'string', description: 'Country (2-letter code)' },
            st: { type: 'string', description: 'State/Province' },
            l: { type: 'string', description: 'Locality/City' },
          },
          description: 'Optional subject DN fields beyond commonName',
        },
      },
      required: ['caId', 'commonName', 'keyAlgorithm', 'validityDays', 'type'],
    },
    destructive: true,
    category: 'PKI - Certificates',
    requiredScope: 'pki:cert:issue',
    invalidateStores: ['certificates', 'ca'],
  },
  {
    name: 'revoke_certificate',
    description:
      'Revoke a certificate. This is permanent: the CA CRL lists it at once. A route or SSL certificate that serves it keeps serving it until it gets another certificate; the answer names them (stillServedBy.routes, stillServedBy.sslCertificates) and a linked SSL certificate turns status error with the reason in renewalError. Ask the user before revoking a certificate in use.',
    parameters: {
      type: 'object',
      properties: {
        certificateId: { type: 'string', description: 'Certificate UUID to revoke' },
        reason: {
          type: 'string',
          enum: [
            'unspecified',
            'keyCompromise',
            'caCompromise',
            'affiliationChanged',
            'superseded',
            'cessationOfOperation',
            'certificateHold',
          ],
          description: 'RFC 5280 revocation reason (default: unspecified)',
        },
      },
      required: ['certificateId'],
    },
    destructive: true,
    category: 'PKI - Certificates',
    requiredScope: 'pki:cert:revoke',
    invalidateStores: ['certificates', 'ca'],
  },
  {
    name: 'delete_certificate',
    description:
      'Permanently delete a PKI certificate that no longer works: revoked, or past its expiry. A valid certificate is refused with CERT_STILL_VALID: revoke it first (revoke_certificate), after the user confirmed. A revoked certificate deleted before it expires stays on its CA CRL until then (keptOnCrlUntil) while the CA exists, so deleting never makes it valid again; deleting the CA ends its CRL (delete_ca). Refused with CERT_IN_USE while a route uses it as internalCertificateId or an SSL certificate is linked from it (details.routes, details.sslCertificates: move those first), and with SYSTEM_CERT for system certificates. Needs pki:cert:revoke on the certificate; audited as cert.delete.',
    parameters: {
      type: 'object',
      properties: {
        certificateId: { type: 'string', description: 'Certificate UUID to delete' },
      },
      required: ['certificateId'],
    },
    destructive: true,
    category: 'PKI - Certificates',
    requiredScope: 'pki:cert:revoke',
    invalidateStores: ['certificates', 'ca'],
  },
  {
    name: 'manage_certificate',
    description:
      'Manage PKI certificates beyond generated issuance. Operations: issue_from_csr, export, chain. Export formats: pem, der, chain (intermediates), fullchain, and the private-key formats private-key, pem-bundle (zip), pkcs12 and jks (passphrase required). Binary formats return contentBase64. Private-key exports are audited and refused for system CAs without admin:system. Operation-specific pki:cert:* scopes are enforced.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['issue_from_csr', 'export', 'chain'] },
        certificateId: { type: 'string' },
        caId: { type: 'string' },
        templateId: { type: 'string' },
        type: { type: 'string', enum: ['tls-server', 'tls-client', 'code-signing', 'email'] },
        csrPem: { type: 'string' },
        validityDays: { type: 'number' },
        overrideSans: { type: 'array', items: { type: 'string' } },
        clampToCaValidity: {
          type: 'boolean',
          description:
            'issue_from_csr: end the certificate with the CA instead of failing when it would outlive the CA.',
        },
        format: {
          type: 'string',
          enum: ['pem', 'der', 'chain', 'fullchain', 'private-key', 'pem-bundle', 'pkcs12', 'jks'],
        },
        passphrase: { type: 'string' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'PKI - Certificates',
    requiredScope: 'pki:cert:view',
    invalidateStores: ['certificates', 'ca'],
    historyRetention: { mode: 'never_full' },
  },
  {
    name: 'list_templates',
    description:
      'List all certificate templates with folderId and sortOrder (built-in templates never have a folder; list_resource_folders with pki_templates names the folders).',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'PKI - Templates',
    requiredScope: 'pki:templates:view',
    invalidateStores: [],
  },
  {
    name: 'create_template',
    description:
      'Create a new certificate template with predefined settings. Fields match the template API: certType (alias type), keyUsage, extKeyUsage (alias extendedKeyUsage), SAN requirements, subject DN defaults, CRL distribution points, AIA, certificate policies, and custom extensions.',
    parameters: {
      type: 'object',
      properties: {
        ...templateProperties(),
        folderId: {
          type: ['string', 'null'],
          description:
            'Destination template folder UUID (list_resource_folders pki_templates); needs pki:templates:folders:manage.',
        },
      },
      required: ['name', 'keyAlgorithm', 'validityDays'],
    },
    destructive: true,
    category: 'PKI - Templates',
    requiredScope: 'pki:templates:create',
    invalidateStores: ['templates'],
  },
  {
    name: 'delete_template',
    description: 'Delete a certificate template. Built-in templates cannot be deleted.',
    parameters: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'Template UUID to delete' },
      },
      required: ['templateId'],
    },
    destructive: true,
    category: 'PKI - Templates',
    requiredScope: 'pki:templates:delete',
    invalidateStores: ['templates'],
  },
  {
    name: 'manage_template',
    description: 'Get or update a PKI certificate template. Operations: get, update (same fields as create_template).',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'update'] },
        templateId: { type: 'string' },
        ...templateProperties(),
      },
      required: ['operation', 'templateId'],
    },
    destructive: true,
    category: 'PKI - Templates',
    requiredScope: 'pki:templates:view',
    invalidateStores: ['templates'],
  },
];

function templateProperties(): Record<string, unknown> {
  const certType = { type: 'string', enum: ['tls-server', 'tls-client', 'code-signing', 'email'] };
  return {
    name: { type: 'string', description: 'Template name' },
    description: { type: 'string' },
    certType,
    type: { ...certType, description: 'Alias of certType' },
    keyAlgorithm: { type: 'string', enum: ['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384'] },
    validityDays: { type: 'number', description: 'Default validity in days (1-3650)' },
    keyUsage: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['digitalSignature', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'nonRepudiation'],
      },
    },
    extKeyUsage: { type: 'array', items: { type: 'string' }, description: 'Named usages or custom OIDs' },
    extendedKeyUsage: { type: 'array', items: { type: 'string' }, description: 'Alias of extKeyUsage' },
    requireSans: { type: 'boolean' },
    sanTypes: { type: 'array', items: { type: 'string', enum: ['dns', 'ip', 'email', 'uri'] } },
    subjectDnFields: {
      type: 'object',
      properties: {
        o: { type: 'string' },
        ou: { type: 'string' },
        l: { type: 'string' },
        st: { type: 'string' },
        c: { type: 'string' },
        serialNumber: { type: 'string' },
      },
    },
    crlDistributionPoints: { type: 'array', items: { type: 'string' } },
    authorityInfoAccess: { type: 'object', properties: { caIssuersUrl: { type: 'string' } } },
    certificatePolicies: {
      type: 'array',
      items: {
        type: 'object',
        properties: { oid: { type: 'string' }, qualifier: { type: 'string' } },
        required: ['oid'],
      },
    },
    customExtensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { oid: { type: 'string' }, critical: { type: 'boolean' }, value: { type: 'string' } },
        required: ['oid', 'value'],
      },
    },
  };
}
