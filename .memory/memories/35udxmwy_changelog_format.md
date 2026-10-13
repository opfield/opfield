---
{
  "id": "35udxmwy",
  "file_name": "35udxmwy_changelog_format",
  "tags": [
    "changelog",
    "format",
    "release-notes",
    "user-preference"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.8,
  "created_at": 1786615289462,
  "updated_at": 1791851154272
}
---
When the user asks for a changelog from the latest tag, first inspect the release-note messages of recent tags in that repository and mirror their established format. For Opfield, output only plain `- ...` bullet lines. Do not add a heading, version/range metadata, commit hashes, diff statistics, verification notes, sections, or explanatory prose unless the user explicitly asks for them.
