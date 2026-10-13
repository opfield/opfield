---
{
  "id": "hjj0ldnf",
  "file_name": "hjj0ldnf_documentation_integrations",
  "tags": [
    "documentation",
    "integrations"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1789033984971,
  "updated_at": 1791851624273
}
---
The public Opfield documentation portal is owned by the separate the-square-labs/gateway-docs repository, not Opfield's root docs/ operational guides. Portal sources are bilingual MDX under src/content/docs/en and ru, navigation is in astro.config.mjs, and its README defines pnpm check plus pnpm build as the publication gate. Preserve existing published URLs when reorganizing navigation. Integrations has dedicated overview, hosting-providers, source-control (Git hosting), ssh-connections, and cloudflare pages; api-and-mcp is presented under Automation while retaining its integrations URL. Link node enrollment/role guides to hosting setup and Docker/Pages build guides to Git setup rather than duplicating connection instructions. Portal source publication and live deployment are separate claims.
