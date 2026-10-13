---
{
  "id": "z179lvxi",
  "file_name": "z179lvxi_gateway_openapi_convention",
  "tags": [
    "backend",
    "hono",
    "openapi",
    "opfield",
    "routing",
    "scalar"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.88,
  "created_at": 1777403134065,
  "updated_at": 1791851998382
}
---
Opfield OpenAPI/Scalar convention:
- Documentation for Hono-native createRoute/router.openapi(...) must live in per-service *.docs.ts files alongside the route modules, not in a centralized docs file.
- Use helpers from packages/backend/src/lib/openapi.ts and construct converted OpenAPIHono routers with defaultHook: openApiValidationHook so that validation errors preserve the existing ZodError response shape.
- The production-facing OpenAPI document path is /api/openapi.json. Scalar docs must load that path because frontend/nginx fallback could otherwise serve /openapi.json as frontend HTML.
- Maintain /openapi.json primarily as a backend compatibility route when needed.
- Docs-specific CSP allowances for Scalar CDN/API/font resources must be route-aware and restricted to /docs.
