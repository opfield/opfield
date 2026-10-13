---
{
  "id": "x7unpgb6",
  "file_name": "x7unpgb6_nginx_access_control",
  "tags": [
    "access-list",
    "nginx",
    "proxy",
    "security"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786184522363,
  "updated_at": 1791851941090
}
---
Opfield proxy access lists must not be hoisted to server scope merely to protect advanced locations: that restores the prior server-level deny model and changes the ACME exception boundary. Keep allow/deny/auth_basic in the generated location / block, then inject the same directives into every direct advanced server-level location during built-in template rendering and pure config generation. Reject allow, deny, auth_basic, auth_basic_user_file, and satisfy in normal advanced config so users cannot replace the injected policy. This covers managed built-in proxy templates; raw/custom templates remain explicit operator-managed escape hatches. After deployment, reapply affected managed proxy hosts/nodes because changing a built-in template alone does not rewrite already applied configs.
