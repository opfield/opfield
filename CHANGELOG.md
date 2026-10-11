# Changelog

Opfield does not keep a changelog file. The release notes of each version are the message of its annotated Git tag and
are published on that tag's GitHub release:

- Opfield: [github.com/opfield/opfield/releases](https://github.com/opfield/opfield/releases), tags `vX.Y.Z`
  (release candidates `vX.Y.Z-rc.N` are marked as pre-releases).
- Relay and node daemons: the same releases page, tags with the component suffix (`vX.Y.Z-relay`, `vX.Y.Z-nginx`,
  `vX.Y.Z-docker`, `vX.Y.Z-monitoring`, `vX.Y.Z-watchdog`). A component is tagged only when it changes.
- Opfield shows the notes of an available update on its update screen before you install it.

Each note is one short line per change that users can see. Every release also lists its signed update manifests and
SBOMs; see [Verifying releases](docs/verify-releases.md).
