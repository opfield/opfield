---
{
  "id": "gqzqcsgc",
  "file_name": "gqzqcsgc_acme_certificates_deployment",
  "tags": [
    "acme",
    "certificates",
    "deployment",
    "nginx-daemon",
    "tls"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785396977270,
  "updated_at": 1791851571712
}
---
Opfield TLS deployment gotcha: ACME certificate rows can correctly store a leaf certificate in certificatePem and intermediates in chainPem while public clients still fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE. In nginx-daemon, DeployCert historically wrote certificatePem alone to a file named fullchain.pem and wrote chainPem only to chain.pem, but generated Nginx configs reference fullchain.pem. The fix is to write leaf certificate followed by chainPem into fullchain.pem while retaining chain.pem separately. Verify with the nginx internal package Go test, then roll out the signed nginx-daemon update and explicitly redeploy the affected certificate or re-save its proxy host; daemon reconnect does not guarantee full sync when the config version hash is unchanged. External verification: openssl s_client must show the intermediate chain and Verify return code 0, and Node fetch must stop failing with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
