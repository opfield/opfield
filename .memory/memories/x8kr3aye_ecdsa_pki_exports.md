---
{
  "id": "x8kr3aye",
  "file_name": "x8kr3aye_ecdsa_pki_exports",
  "tags": [
    "audit",
    "certificates",
    "pkcs12",
    "pki",
    "security"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787183789985,
  "updated_at": 1791851949640
}
---
PKCS#12 export via node-forge fails for Opfield-issued ECDSA leaves because its X.509 parser only supports RSA public-key OIDs. Use OpenSSL in Opfield runtime images for PKCS#12 creation and pass private key, certificate, optional intermediate chain, and passphrase through dedicated child-process file descriptors; never persist plaintext key material or include it in argv/environment/logs. Key-bearing certificate exports (`private-key`, PEM bundle, PKCS#12, JKS) must reuse resource-scoped `pki:cert:export`, write a redacted `cert.export_key` audit event with only format metadata, and fail closed when `AuditService.log()` returns false. PEM bundle semantics: certificate.pem + private-key.pem + optional intermediate-only chain.pem + leaf-first fullchain.pem.
