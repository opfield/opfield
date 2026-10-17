# OFCA Container Archives

[Back to README](../README.md)

Opfield Container Archive (`.ofca`) is a streaming format for moving or copying a standalone Docker container between Opfield-managed nodes. It is a portable container configuration, not a backup format: named-volume contents and external application data are never included.

## Archive contents

OFCA v1 contains an Opfield-owned, versioned manifest with only settings that Opfield can safely create again:

- image identity and the original registry reference when available;
- entrypoint, command, working directory, user, hostname, and supported labels;
- optional Opfield-managed container environment values;
- optional secret values;
- published ports;
- named-volume declarations;
- attached network metadata;
- restart policy, stop timeout, and supported CPU, memory, and PID limits;
- either an embedded Docker image or an immutable registry digest.

The manifest is deliberately not a serialized Docker inspect response. Containers using unsupported or host-sensitive settings, such as privileged mode, devices or GPUs, host bind mounts, host namespaces, capabilities, custom runtimes, custom log drivers, health checks, or unsupported resource controls, are rejected during export with an explicit reason instead of producing an incomplete archive. This includes containers using the Secure (`runsc`) runtime profile.

An Opfield-managed GPU attachment is therefore not portable in OFCA v1: the UI disables export and the API rejects it. GPU-attached standalone containers and blue/green deployments also cannot use cross-node migration in this version. Detach the GPU through the normal recreate flow before using either portability workflow.

**Include environment** controls whether Opfield-managed runtime environment values are included. It is available only to users with environment access. **Include secrets** is available only when environment inclusion is enabled by a user with secret access. Secret values inside a `.ofca` file are plaintext archive data; the downloaded file must be handled as sensitive. On import, Opfield encrypts them again with the destination Opfield key. Image-defined `ENV` values can still be part of a portable image; excluding the option omits the container-specific runtime overrides.

## Image modes

Open a standalone container and choose **Export archive**:

- **Portable** embeds the exact Docker image. The archive can be imported without registry access and streams from Docker through the daemon and Opfield directly to the browser.
- **Registry-backed** stores the exact image ID and an immutable repository digest without embedding the image. The target node must already have that image or be able to pull it through a public registry or registry credentials configured in Opfield. Registry credentials are never written into the archive.

Portable mode can optionally capture the current writable layer with a non-pausing Docker commit. This does not interrupt the container, but concurrent writes are not transactionally consistent. Database data belongs in volumes and needs database-native backup tooling; writable-layer capture is not a live database backup.

When a portable archive is imported, Opfield removes Docker repository-tag metadata before loading its image and creates the container from the loaded immutable image ID. The original registry reference is retained only as Opfield update metadata, so a later authorized container update can pull it normally without allowing an archive to change a local Docker tag.

## Import planning and remapping

Open **Docker > Containers**, choose **Import .ofca**, select the archive and target node, and confirm the container name. Opfield reads only the local manifest before upload and builds a best-effort import plan:

- an occupied container name receives the next available suffix automatically;
- compatible existing networks are reused;
- portable missing networks are created when the user has network-create access;
- networks that cannot be reproduced fall back to the target node's default `bridge` network;
- source IP and MAC addresses are discarded so Docker allocates destination-local endpoint addresses;
- named volumes are recreated empty as uniquely named Opfield-managed local volumes, so old same-named data is never attached accidentally;
- a source volume that cannot be recreated directly may be replaced with a new managed local volume; an existing destination can be selected only when it is already Opfield-managed and has the safe local driver, local scope, and no driver options;
- archives containing host bind mounts are rejected rather than importing destination-node host paths;
- occupied host ports are shown for remapping; port `0` asks Docker to allocate a free host port.

The imported container remains stopped. Opfield restores ordinary environment values and encrypts imported secrets before publishing the created container to the rest of Opfield. If persistence fails after Docker creation, Opfield removes the partial container and archive-created resources.

The export/import UI is available only for standalone containers. Opfield deployment members continue to be managed through their deployment.

## API

- `GET /api/docker/nodes/{nodeId}/containers/{containerId}/archive?imageMode=portable&includeWritableLayer=false&includeEnvironment=false&includeSecrets=false` streams an archive. Export always requires the dedicated `docker:containers:export` scope. Portable mode additionally requires container file access; `includeEnvironment=true` requires environment access; and `includeSecrets=true` additionally requires secret access. `imageMode=registry` references the image in its registry and cannot carry the writable layer: `includeWritableLayer=true` with it is refused with 400. A container that runs on Secure Runtime (gVisor) cannot be exported (409 `DOCKER_ARCHIVE_SECURE_RUNTIME`), and one whose settings an archive cannot reproduce is refused with 409 `DOCKER_ARCHIVE_UNSUPPORTED`, which names the settings. The API defaults `includeEnvironment` to `true` for existing clients.
- `POST /api/docker/nodes/{nodeId}/containers/archive?name={newName}&resolution={json}` accepts an `application/vnd.opfield.ofca` body and requires container-create on the target node. Importing an archive that contains environment or secret values additionally requires the corresponding environment or secret access. The optional `resolution` object can contain `networks`, `volumes`, and `ports` mappings plus `createNetworks` and `createVolumes` lists; creating archive-declared local volumes or missing networks requires the corresponding create permissions.

`networks` and `volumes` map an archive's network or volume (the name in the archive manifest) to the one to use on the target node. `createNetworks` and `createVolumes` list archive networks and volumes, again by their name in the archive, that the import creates on the target node. A network that is both created and mapped is created under its mapped name: to create `source-app` as `target-app`, list `source-app` in `createNetworks` and map it in `networks`. Naming the target name in `createNetworks` is refused with 400 `OFCA_RESOLUTION_INVALID`.

Example resolution:

```json
{
  "networks": { "source-app": "target-app" },
  "createNetworks": ["source-app"],
  "volumes": { "source-data": "managed-target-data" },
  "ports": { "8080/tcp:8080": 18080 }
}
```

## MCP agents

Remote MCP clients use the MCP-only `download_docker_archive` (container or volume export) and `upload_docker_container_archive` (import) tools. With a shell, operation `link` runs the same checks as the API above and returns a one-time URL, valid for 15 minutes and usable once, with a ready curl command: `curl -fsS -o <file> <url>` streams an export from the node, and `curl -T container.ofca <url>` streams a `.ofca` archive into the import, whose response is the new stopped container. An export link is issued only when the token holds every scope the export needs, file access for a portable image, environment and secret access when they are included; a missing one refuses the `link` call itself. Using a link repeats the permission, license and node checks with the MCP token's scopes bounded by the owner's current grants. An interrupted upload imports nothing; an interrupted download makes curl exit non-zero and leaves an incomplete file. Without a shell, the tools keep a base64 `begin`/`chunk` workflow of at most 1 MiB per call.

## Wire format and integrity

OFCA v1 starts with the eight-byte magic `OFCA\r\n\x1a\n`, followed by length-delimited frames:

1. JSON manifest;
2. in portable mode, image frames with at most 1 MiB of image bytes and an individual SHA-256 checksum;
3. JSON footer containing the manifest digest, complete image-stream digest, and image byte count.

Registry-backed archives contain no image frames and use the SHA-256 digest of an empty image stream. Each frame begins with a one-byte type and an unsigned 64-bit big-endian payload length. The media type is `application/vnd.opfield.ofca`.

The framing supports constant-memory daemon/backend transport with backpressure. The browser may retain the completed download as a `Blob` so it can hand the file to the operating system.
