---
{
  "id": "1jazd67l",
  "file_name": "1jazd67l_grpc_optional_cert",
  "tags": [
    "compatibility",
    "daemon",
    "grpc",
    "mtls",
    "opfield"
  ],
  "layer": "lite",
  "ref": "ov8vmocj",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1777128935634,
  "updated_at": 1791851816569
}
---
[→ ov8vmocj] In the Opfield repo, @grpc/grpc-js `ServerCredentials.createSsl(rootCerts, keyPairs, false)` sets `requestCert: false`, so the server will not request daemon...
