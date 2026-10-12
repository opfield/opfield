import type { ReactNode } from "react";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ObjectStorageConnection, ObjectStorageProvider } from "@/types";
import { isFileProtocolProvider } from "@/types";

export interface StorageConnectionDraft {
  name: string;
  description: string;
  tags: string;
  provider: ObjectStorageProvider;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  defaultBucket: string;
  forcePathStyle: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey: string;
  hostKeyFingerprint: string;
  passphrase: string;
  caPem: string;
  basePath: string;
  implicitTls: boolean;
  hasStoredSecret?: boolean;
  hasStoredSessionToken?: boolean;
  hasStoredPassword?: boolean;
  hasStoredPrivateKey?: boolean;
  hasStoredCaPem?: boolean;
  /** The saved target the stored secrets belong to; absent when creating. */
  storedTarget?: {
    provider: ObjectStorageProvider;
    endpoint: string;
    host: string;
    port: string;
    username: string;
  };
}

interface ProviderPreset {
  endpoint: string;
  endpointPlaceholder: string;
  endpointDisabled: boolean;
  region: string;
  forcePathStyle: boolean;
  /** Placeholder port, shown so the protocol default is discoverable. */
  portPlaceholder?: string;
}

export const PROVIDER_PRESETS: Record<ObjectStorageProvider, ProviderPreset> = {
  aws: {
    endpoint: "",
    endpointPlaceholder: "Optional — leave blank for AWS S3",
    endpointDisabled: false,
    region: "us-east-1",
    forcePathStyle: false,
  },
  cloudflare_r2: {
    endpoint: "",
    endpointPlaceholder: "https://<account-id>.r2.cloudflarestorage.com",
    endpointDisabled: false,
    region: "auto",
    forcePathStyle: false,
  },
  minio: {
    endpoint: "",
    endpointPlaceholder: "http://minio:9000",
    endpointDisabled: false,
    region: "us-east-1",
    forcePathStyle: true,
  },
  // Managed SeaweedFS clusters; not offered as a preset for external connections.
  seaweedfs: {
    endpoint: "",
    endpointPlaceholder: "http://seaweedfs:8333",
    endpointDisabled: false,
    region: "us-east-1",
    forcePathStyle: true,
  },
  other: {
    endpoint: "",
    endpointPlaceholder: "https://s3.example.com",
    endpointDisabled: false,
    region: "us-east-1",
    forcePathStyle: false,
  },
  ftp: {
    endpoint: "",
    endpointPlaceholder: "",
    endpointDisabled: true,
    region: "",
    forcePathStyle: false,
    portPlaceholder: "21",
  },
  ftps: {
    endpoint: "",
    endpointPlaceholder: "",
    endpointDisabled: true,
    region: "",
    forcePathStyle: false,
    portPlaceholder: "21 (990 for implicit TLS)",
  },
  sftp: {
    endpoint: "",
    endpointPlaceholder: "",
    endpointDisabled: true,
    region: "",
    forcePathStyle: false,
    portPlaceholder: "22",
  },
};

const PROVIDER_OPTIONS: Array<{ value: ObjectStorageProvider; label: string }> = [
  { value: "aws", label: "AWS S3" },
  { value: "cloudflare_r2", label: "Cloudflare R2" },
  { value: "minio", label: "MinIO" },
  { value: "other", label: "Other (S3-compatible)" },
  { value: "sftp", label: "SFTP" },
  { value: "ftp", label: "FTP" },
  { value: "ftps", label: "FTPS" },
];

/** Secrets are never echoed back into the draft — a blank field keeps the stored value. */
const EMPTY_SECRETS = {
  secretAccessKey: "",
  sessionToken: "",
  password: "",
  privateKey: "",
  passphrase: "",
  caPem: "",
} as const;

export function draftFromConnection(
  connection?: ObjectStorageConnection | null
): StorageConnectionDraft {
  if (!connection) {
    const preset = PROVIDER_PRESETS.aws;
    return {
      name: "",
      description: "",
      tags: "",
      provider: "aws",
      endpoint: preset.endpoint,
      region: preset.region,
      accessKeyId: "",
      ...EMPTY_SECRETS,
      defaultBucket: "",
      forcePathStyle: preset.forcePathStyle,
      host: "",
      port: "",
      username: "",
      basePath: "",
      hostKeyFingerprint: "",
      implicitTls: false,
      hasStoredSecret: false,
      hasStoredSessionToken: false,
      hasStoredPassword: false,
      hasStoredPrivateKey: false,
      hasStoredCaPem: false,
    };
  }

  return {
    name: connection.name,
    description: connection.description ?? "",
    tags: connection.tags.join(", "),
    provider: connection.provider,
    endpoint: connection.endpoint ?? "",
    region: connection.region ?? "",
    accessKeyId: connection.accessKeyId ?? "",
    ...EMPTY_SECRETS,
    defaultBucket: connection.defaultBucket ?? "",
    forcePathStyle: connection.forcePathStyle,
    host: connection.host ?? "",
    port: connection.port ? String(connection.port) : "",
    username: connection.username ?? "",
    basePath: connection.basePath ?? "",
    hostKeyFingerprint: connection.hostKeyFingerprint ?? "",
    implicitTls: connection.implicitTls ?? false,
    hasStoredSecret: connection.hasStoredSecret,
    hasStoredSessionToken: connection.hasStoredSessionToken,
    hasStoredPassword: connection.hasStoredPassword,
    hasStoredPrivateKey: connection.hasStoredPrivateKey,
    hasStoredCaPem: connection.hasStoredCaPem,
    storedTarget: {
      provider: connection.provider,
      endpoint: connection.endpoint ?? "",
      host: connection.host ?? "",
      port: connection.port ? String(connection.port) : "",
      username: connection.username ?? "",
    },
  };
}

/**
 * Mirrors the API rule: a stored secret is never sent to a target the editor
 * just changed (provider, endpoint, or host/port/username), so the secret has
 * to be re-entered in the same save.
 */
export function secretReentryRequired(draft: StorageConnectionDraft): boolean {
  const stored = draft.storedTarget;
  if (!stored) return false;
  if (!isFileProtocolProvider(draft.provider)) {
    const endpoint = draft.endpoint.trim();
    return (
      Boolean(draft.hasStoredSecret) &&
      (draft.provider !== stored.provider || (endpoint !== "" && endpoint !== stored.endpoint))
    );
  }
  if (!draft.hasStoredPassword && !draft.hasStoredPrivateKey) return false;
  const port = Number.parseInt(draft.port.trim(), 10);
  return (
    draft.provider !== stored.provider ||
    draft.host.trim() !== stored.host ||
    (Number.isFinite(port) && String(port) !== stored.port) ||
    draft.username.trim() !== stored.username
  );
}

export function buildStoragePayload(draft: StorageConnectionDraft): Record<string, unknown> {
  const tags = draft.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const base = {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    tags,
    provider: draft.provider,
  };

  if (isFileProtocolProvider(draft.provider)) {
    const port = Number.parseInt(draft.port.trim(), 10);
    return {
      ...base,
      config: {
        host: draft.host.trim(),
        // Blank means "use the protocol default", which the backend resolves.
        ...(Number.isFinite(port) ? { port } : {}),
        username: draft.username.trim(),
        ...(draft.password !== "" ? { password: draft.password } : {}),
        ...(draft.privateKey !== "" ? { privateKey: draft.privateKey } : {}),
        ...(draft.passphrase !== "" ? { passphrase: draft.passphrase } : {}),
        ...(draft.caPem !== "" ? { caPem: draft.caPem } : {}),
        basePath: draft.basePath.trim() || null,
        ...(draft.provider === "sftp"
          ? { hostKeyFingerprint: draft.hostKeyFingerprint.trim() }
          : {}),
        ...(draft.provider === "ftps" ? { implicitTls: draft.implicitTls } : {}),
        ...(draft.defaultBucket.trim() ? { defaultBucket: draft.defaultBucket.trim() } : {}),
      },
    };
  }

  return {
    ...base,
    config: {
      ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
      region: draft.region.trim(),
      ...(draft.accessKeyId.trim() ? { accessKeyId: draft.accessKeyId.trim() } : {}),
      ...(draft.secretAccessKey !== "" ? { secretAccessKey: draft.secretAccessKey } : {}),
      ...(draft.sessionToken !== "" ? { sessionToken: draft.sessionToken } : {}),
      ...(draft.defaultBucket.trim() ? { defaultBucket: draft.defaultBucket.trim() } : {}),
      forcePathStyle: draft.forcePathStyle,
    },
  };
}

export function StorageConnectionForm({
  draft,
  onChange,
  disableProvider = false,
  mode = "full",
  folderField,
}: {
  draft: StorageConnectionDraft;
  onChange: (next: StorageConnectionDraft) => void;
  disableProvider?: boolean;
  mode?: "full" | "metadata";
  /** The create dialog's Folder field: shares a row with Tags. */
  folderField?: ReactNode;
}) {
  const set = <K extends keyof StorageConnectionDraft>(key: K, value: StorageConnectionDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const metadataOnly = mode === "metadata";
  const preset = PROVIDER_PRESETS[draft.provider];
  const fileProtocol = isFileProtocolProvider(draft.provider);
  const reenterSecret = secretReentryRequired(draft);
  const keepPassword = draft.hasStoredPassword && !reenterSecret;
  const keepPrivateKey = draft.hasStoredPrivateKey && !reenterSecret;

  const handleProviderChange = (value: ObjectStorageProvider) => {
    const next = PROVIDER_PRESETS[value];
    onChange({
      ...draft,
      provider: value,
      endpoint: next.endpoint,
      region: next.region,
      forcePathStyle: next.forcePathStyle,
      // Switching between the S3 and file-protocol families clears the port so
      // the new protocol's default applies instead of the old protocol's port.
      ...(isFileProtocolProvider(value) === isFileProtocolProvider(draft.provider)
        ? {}
        : { port: "" }),
    });
  };

  const descriptionField = (
    <div className="min-w-0 space-y-1.5">
      <label className="text-sm font-medium">Description</label>
      <Input
        value={draft.description}
        onChange={(e) => set("description", e.target.value)}
        placeholder="Optional"
      />
    </div>
  );
  const tagsField = (
    <div className="min-w-0 space-y-1.5">
      <label className="text-sm font-medium">Tags</label>
      <Input
        placeholder="team, red:production, green:analytics"
        value={draft.tags}
        onChange={(e) => set("tags", e.target.value)}
      />
    </div>
  );

  const defaultBucketField = (
    <div className="min-w-0 space-y-1.5">
      <label className="text-sm font-medium">Default Bucket</label>
      <Input
        placeholder="Optional"
        value={draft.defaultBucket}
        onChange={(e) => set("defaultBucket", e.target.value)}
      />
    </div>
  );
  const pathStyleSwitch = (
    <SwitchCard
      label="Force path-style addressing"
      description="For MinIO, SeaweedFS and most self-hosted servers"
      checked={draft.forcePathStyle}
      onCheckedChange={(checked) => set("forcePathStyle", checked)}
    />
  );

  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${metadataOnly ? "md:grid-cols-1" : "md:grid-cols-2"}`}>
        {!metadataOnly && (
          <div className="min-w-0 space-y-1.5">
            <label className="text-sm font-medium">Provider</label>
            <Select
              value={draft.provider}
              onValueChange={(value) => handleProviderChange(value as ObjectStorageProvider)}
              disabled={disableProvider}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="min-w-0 space-y-1.5">
          <label className="text-sm font-medium">Name</label>
          <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </div>
      </div>

      {folderField ? (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {folderField}
            {tagsField}
          </div>
          {descriptionField}
        </>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {descriptionField}
          {tagsField}
        </div>
      )}

      {!metadataOnly && fileProtocol && (
        <>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Host<span className="text-destructive"> *</span>
              </label>
              <Input
                placeholder="files.example.com"
                value={draft.host}
                onChange={(e) => set("host", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Port</label>
              <Input
                inputMode="numeric"
                placeholder={preset.portPlaceholder}
                value={draft.port}
                onChange={(e) => set("port", e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">
                Username
                {draft.provider === "sftp" && <span className="text-destructive"> *</span>}
              </label>
              <Input
                placeholder={draft.provider === "sftp" ? "" : "anonymous"}
                value={draft.username}
                onChange={(e) => set("username", e.target.value)}
              />
            </div>

            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">Password</label>
              <Input
                type="password"
                placeholder={
                  keepPassword
                    ? "Leave blank to keep current password"
                    : draft.provider === "sftp"
                      ? "Optional if a private key is set"
                      : "Optional for anonymous servers"
                }
                value={draft.password}
                onChange={(e) => set("password", e.target.value)}
              />
              {keepPassword && draft.password === "" && (
                <Badge variant="secondary">Existing password preserved</Badge>
              )}
              {reenterSecret && draft.password === "" && draft.privateKey === "" && (
                <p className="text-xs text-destructive">
                  Re-enter the {draft.provider === "sftp" ? "password or private key" : "password"}{" "}
                  when changing the host, port, username or protocol.
                </p>
              )}
            </div>
          </div>

          {draft.provider === "sftp" && (
            <>
              <SettingsControlRow
                title="SSH host key fingerprint"
                description="Verify the SHA256 fingerprint with the storage administrator before connecting."
              >
                <Input
                  aria-label="SSH host key fingerprint"
                  placeholder="SHA256:…"
                  value={draft.hostKeyFingerprint}
                  onChange={(e) => set("hostKeyFingerprint", e.target.value)}
                />
              </SettingsControlRow>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Private Key</label>
                <Textarea
                  rows={4}
                  className="font-mono text-xs"
                  placeholder={
                    keepPrivateKey
                      ? "Leave blank to keep current key"
                      : "-----BEGIN OPENSSH PRIVATE KEY-----"
                  }
                  value={draft.privateKey}
                  onChange={(e) => set("privateKey", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Saving a private key clears any stored password, and vice versa — they are
                  alternative authentication methods.
                </p>
                {keepPrivateKey && draft.privateKey === "" && (
                  <Badge variant="secondary">Existing key preserved</Badge>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Key Passphrase</label>
                <Input
                  type="password"
                  placeholder="Optional — only if the key is encrypted"
                  value={draft.passphrase}
                  onChange={(e) => set("passphrase", e.target.value)}
                />
              </div>
            </>
          )}

          {draft.provider === "ftps" && (
            <>
              <SwitchCard
                label="Implicit TLS"
                description="Off: explicit AUTH TLS on port 21. On: implicit TLS, usually port 990."
                checked={draft.implicitTls}
                onCheckedChange={(checked) => set("implicitTls", checked)}
              />

              <div className="space-y-1.5">
                <label className="text-sm font-medium">CA Certificate</label>
                <Textarea
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={
                    draft.hasStoredCaPem
                      ? "Leave blank to keep current CA"
                      : "Optional — pin a private CA instead of the system trust store"
                  }
                  value={draft.caPem}
                  onChange={(e) => set("caPem", e.target.value)}
                />
                {draft.hasStoredCaPem && draft.caPem === "" && (
                  <Badge variant="secondary">Existing CA preserved</Badge>
                )}
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Base Path</label>
            <Input
              placeholder="Optional — e.g. /srv/data"
              value={draft.basePath}
              onChange={(e) => set("basePath", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Confines this connection to a subtree. Top-level directories beneath it are shown as
              buckets in the object browser.
            </p>
          </div>
        </>
      )}

      {!metadataOnly && !fileProtocol && (
        <>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">
                Endpoint
                {draft.provider !== "aws" && <span className="text-destructive"> *</span>}
              </label>
              <Input
                placeholder={preset.endpointPlaceholder}
                disabled={preset.endpointDisabled}
                value={draft.endpoint}
                onChange={(e) => set("endpoint", e.target.value)}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">Region</label>
              <Input value={draft.region} onChange={(e) => set("region", e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">Access Key ID</label>
              <Input
                value={draft.accessKeyId}
                onChange={(e) => set("accessKeyId", e.target.value)}
              />
            </div>

            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">Secret Access Key</label>
              <Input
                type="password"
                placeholder={
                  draft.hasStoredSecret && !reenterSecret
                    ? "Leave blank to keep current secret"
                    : ""
                }
                value={draft.secretAccessKey}
                onChange={(e) => set("secretAccessKey", e.target.value)}
              />
              {draft.hasStoredSecret && !reenterSecret && draft.secretAccessKey === "" && (
                <Badge variant="secondary">Existing secret preserved</Badge>
              )}
              {reenterSecret && draft.secretAccessKey === "" && (
                <p className="text-xs text-destructive">
                  Re-enter the secret access key when changing the endpoint or provider.
                </p>
              )}
            </div>

            <div className="min-w-0 space-y-1.5">
              <label className="text-sm font-medium">Session Token</label>
              <Input
                type="password"
                placeholder={
                  draft.hasStoredSessionToken && !reenterSecret
                    ? "Leave blank to keep current token"
                    : "Optional"
                }
                value={draft.sessionToken}
                onChange={(e) => set("sessionToken", e.target.value)}
              />
              {draft.hasStoredSessionToken && !reenterSecret && draft.sessionToken === "" && (
                <Badge variant="secondary">Existing session token preserved</Badge>
              )}
            </div>

            {defaultBucketField}
          </div>

          {pathStyleSwitch}
        </>
      )}
    </div>
  );
}
