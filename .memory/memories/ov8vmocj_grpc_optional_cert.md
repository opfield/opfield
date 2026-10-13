---
{
  "id": "ov8vmocj",
  "file_name": "ov8vmocj_grpc_optional_cert",
  "tags": [
    "compatibility",
    "daemon",
    "grpc",
    "mtls",
    "opfield"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1777128935634,
  "updated_at": 1791851816569
}
---
In the Opfield repo, @grpc/grpc-js `ServerCredentials.createSsl(rootCerts, keyPairs, false)` sets `requestCert: false`, so the server will not request daemon client certificates and `extractNodeIdFromCert()` will usually return null. To keep enrollment working while still allowing CommandStream/LogStream handlers to require verified daemon certs, use `grpc.experimental.createCertificateProviderServerCredentials` with the same static provider for CA and identity and `requireClientCertificate=false`; this sets `requestCert: true` and `rejectUnauthorized: false`. Then `extractNodeIdFromCert()` must check `socket.authorized === true` before trusting the CN.
