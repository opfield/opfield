import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  DockerInternalRegistryStorage,
  DockerInternalRegistryStorageInput,
  ObjectStorageConnection,
} from "@/types";

const KEYS = "__keys";
const FILE_PROTOCOLS = new Set(["ftp", "ftps", "sftp"]);

export interface RegistryStorageForm {
  backend: "filesystem" | "s3";
  /** KEYS: the access keys below; otherwise an S3 storage connection. */
  credentials: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootDirectory: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  /** Empty keeps the secret key in use. */
  secretAccessKey: string;
}

function formFromStorage(storage: DockerInternalRegistryStorage | undefined): RegistryStorageForm {
  const s3 = storage?.backend === "s3" ? storage.s3 : null;
  return {
    backend: storage?.backend ?? "filesystem",
    credentials: KEYS,
    endpoint: s3?.endpoint ?? "",
    region: s3?.region ?? "us-east-1",
    bucket: s3?.bucket ?? "",
    rootDirectory: s3?.rootDirectory ?? "",
    forcePathStyle: s3?.forcePathStyle ?? true,
    accessKeyId: s3?.accessKeyId ?? "",
    secretAccessKey: "",
  };
}

/** The storage part of the internal registry form: what is typed, whether it changed, and what Save sends. */
export function useRegistryStorageForm(storage: DockerInternalRegistryStorage | undefined) {
  const [form, setForm] = useState<RegistryStorageForm>(() => formFromStorage(storage));
  const saved = useMemo(() => formFromStorage(storage), [storage]);
  const reset = useCallback(
    (next: DockerInternalRegistryStorage | undefined) => setForm(formFromStorage(next)),
    []
  );
  const currentKey = storage?.backend === "s3" ? storage.s3?.accessKeyId : undefined;
  const dirty =
    form.backend !== saved.backend ||
    (form.backend === "s3" &&
      (form.credentials !== KEYS ||
        form.secretAccessKey !== "" ||
        (
          [
            "endpoint",
            "region",
            "bucket",
            "rootDirectory",
            "forcePathStyle",
            "accessKeyId",
          ] as const
        ).some((field) => form[field] !== saved[field])));
  const usesConnection = form.credentials !== KEYS;
  const valid =
    form.backend === "filesystem" ||
    (usesConnection
      ? true
      : Boolean(
          form.bucket.trim() &&
            form.accessKeyId.trim() &&
            (form.secretAccessKey || form.accessKeyId.trim() === currentKey)
        ));
  const input = (): DockerInternalRegistryStorageInput => {
    if (form.backend === "filesystem") return { backend: "filesystem" };
    const location = {
      bucket: form.bucket.trim() || undefined,
      rootDirectory: form.rootDirectory.trim(),
    };
    if (usesConnection) return { backend: "s3", connectionId: form.credentials, ...location };
    return {
      backend: "s3",
      ...location,
      endpoint: form.endpoint.trim(),
      region: form.region.trim() || undefined,
      forcePathStyle: form.forcePathStyle,
      accessKeyId: form.accessKeyId.trim(),
      secretAccessKey: form.secretAccessKey || undefined,
    };
  };
  return { form, setForm, dirty, valid, input, reset };
}

function switchSummary(storage: DockerInternalRegistryStorage | undefined): string | null {
  const repair = storage?.repair;
  if (repair) {
    const split = repair.observed
      ? ` The registry runs on ${storageName(repair.observed.container)}, while the settings select ${storageName(repair.observed.env)}.`
      : "";
    return `The registry storage is being repaired.${split} Attempt ${repair.attempts} failed: ${repair.lastError}. Opfield tries again at ${new Date(repair.nextAttemptAt).toLocaleTimeString()}; builds wait until then.`;
  }
  const last = storage?.lastSwitch;
  if (!last) return null;
  const target = last.target === "s3" ? "the S3 bucket" : "local disk";
  if (last.status === "running") {
    const step = last.phase ? ` (${last.phase.replaceAll("_", " ")})` : "";
    return `Moving the registry to ${target}${step}: builds wait until it finishes.`;
  }
  if (last.status === "failed")
    return `The move to ${target} failed: ${last.error ?? "unknown error"}`;
  const copied =
    last.copiedFiles !== null
      ? ` (${last.copiedFiles} files, ${formatBytes(last.copiedBytes ?? 0)} copied)`
      : "";
  return `Moved to ${target}${copied}.${last.error ? ` ${last.error}` : ""}`;
}

function storageName(backend: "filesystem" | "s3"): string {
  return backend === "s3" ? "the S3 bucket" : "local disk";
}

export function InternalRegistryStorageRows({
  storage,
  form,
  onChange,
}: {
  storage: DockerInternalRegistryStorage | undefined;
  form: RegistryStorageForm;
  onChange: (next: RegistryStorageForm) => void;
}) {
  const hasScope = useAuthStore((store) => store.hasScope);
  const [connections, setConnections] = useState<ObjectStorageConnection[]>([]);
  const update = (patch: Partial<RegistryStorageForm>) => onChange({ ...form, ...patch });
  const usesConnection = form.credentials !== KEYS;
  const keyInUse = storage?.backend === "s3" && storage.s3?.accessKeyId === form.accessKeyId.trim();
  const summary = switchSummary(storage);

  // Storage connections are optional: without them (or the scope to use their keys) the keys are typed in.
  useEffect(() => {
    if (form.backend !== "s3") return;
    let current = true;
    void api
      .listObjectStorages({ limit: 200 })
      .then((response) => {
        if (!current) return;
        setConnections(
          response.data.filter(
            (item) =>
              !FILE_PROTOCOLS.has(item.provider) &&
              // Managed storage is reached only through Opfield: the registry container cannot use it.
              item.origin !== "managed" &&
              hasScope(`storage:credentials:use:${item.id}`)
          )
        );
      })
      .catch(() => {
        if (current) setConnections([]);
      });
    return () => {
      current = false;
    };
  }, [form.backend, hasScope]);

  return (
    <>
      <SettingsControlRow
        title="Storage"
        description={
          form.backend === "s3"
            ? "Images are kept in an S3 bucket."
            : "Images are kept on the registry volume of the Opfield host."
        }
        help="Switching copies the stored images to the new storage while pulls keep working and builds wait, then restarts the registry and checks the images in use. The bucket is tested first, and a failed switch leaves the registry on its current storage. After a move to S3 the images are removed from the local disk; switching back copies them from the bucket. Managed storage cannot hold the registry: Opfield reaches it through a private tunnel the registry container cannot use, so use an external S3 service."
      >
        <Select
          value={form.backend}
          onValueChange={(value) => update({ backend: value as RegistryStorageForm["backend"] })}
        >
          <SelectTrigger className="sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="filesystem">Local disk</SelectItem>
            <SelectItem value="s3">S3 bucket</SelectItem>
          </SelectContent>
        </Select>
      </SettingsControlRow>
      {form.backend === "s3" && (
        <>
          {connections.length > 0 && (
            <SettingsControlRow
              title="Credentials"
              description="Access keys, or the endpoint and keys of a storage connection."
            >
              <Select
                value={form.credentials}
                onValueChange={(value) => update({ credentials: value })}
              >
                <SelectTrigger className="sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEYS}>Access keys</SelectItem>
                  {connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
          )}
          {!usesConnection && (
            <>
              <SettingsControlRow
                title="Endpoint"
                description="Leave empty for AWS S3."
                help="The S3 API address the registry container reaches, for example https://s3.example.com or http://seaweedfs:8333."
              >
                <Input
                  className="sm:w-72"
                  value={form.endpoint}
                  placeholder="https://s3.example.com"
                  onChange={(event) => update({ endpoint: event.target.value })}
                />
              </SettingsControlRow>
              <SettingsControlRow title="Region" description="us-east-1 when the service has none.">
                <Input
                  className="sm:w-72"
                  value={form.region}
                  placeholder="us-east-1"
                  onChange={(event) => update({ region: event.target.value })}
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Path-style access"
                description="On for MinIO, SeaweedFS and most self-hosted S3."
              >
                <Switch
                  checked={form.forcePathStyle}
                  onChange={(checked) => update({ forcePathStyle: checked })}
                  ariaLabel="Path-style access"
                />
              </SettingsControlRow>
              <SettingsControlRow title="Access key">
                <Input
                  className="sm:w-72"
                  value={form.accessKeyId}
                  autoComplete="off"
                  onChange={(event) => update({ accessKeyId: event.target.value })}
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Secret key"
                description={keyInUse ? "Leave empty to keep the key in use." : undefined}
              >
                <Input
                  className="sm:w-72"
                  type="password"
                  autoComplete="new-password"
                  value={form.secretAccessKey}
                  placeholder={keyInUse ? "Unchanged" : undefined}
                  onChange={(event) => update({ secretAccessKey: event.target.value })}
                />
              </SettingsControlRow>
            </>
          )}
          <SettingsControlRow
            title="Bucket"
            description={usesConnection ? "Empty uses the connection's default bucket." : undefined}
          >
            <Input
              className="sm:w-72"
              value={form.bucket}
              placeholder="registry"
              onChange={(event) => update({ bucket: event.target.value })}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Folder"
            description="Optional folder in the bucket. It must hold no other registry data."
          >
            <Input
              className="sm:w-72"
              value={form.rootDirectory}
              placeholder="opfield-registry"
              onChange={(event) => update({ rootDirectory: event.target.value })}
            />
          </SettingsControlRow>
        </>
      )}
      {summary && (
        <SettingsControlRow title="Last storage switch" description={summary}>
          <span className="text-right text-sm text-muted-foreground">
            {storage?.repair ? "repairing" : storage?.lastSwitch?.status}
          </span>
        </SettingsControlRow>
      )}
    </>
  );
}
