import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import {
  ResourceListCell,
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  ManagedStorageAccessKey,
  ManagedStorageAccessKeyAccess,
  ManagedStorageEngine,
} from "@/types";

const KEY_COLUMNS: ResourceListColumn[] = [
  { id: "name", label: "Name" },
  { id: "key", label: "Access key" },
  { id: "scope", label: "Access & buckets" },
  { id: "created", label: "Created", width: 160 },
  { id: "expiry", label: "Expiry", width: 160 },
  { id: "actions", label: "", width: 56 },
];

// Mirrors the backend's `managedStorageBucketNameSchema`
// (packages/backend/src/modules/storage/managed-storage.schemas.ts): lowercase
// alphanumerics, dots and hyphens; must start/end alphanumeric; 3-63 chars.
// Validated here purely so the user isn't surprised by a 400 — the server is
// the real enforcement boundary (it's what stops a wildcard-like name from
// widening a "scoped" key's policy back to every bucket).
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

type BucketScopeMode = "all" | "specific";

function parseBucketNames(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return Array.from(seen);
}

function describeKeyScope(key: ManagedStorageAccessKey): string {
  const access: ManagedStorageAccessKeyAccess = key.access ?? "read-write";
  const accessLabel = access === "read-only" ? "read-only" : "read-write";
  const scopeLabel = key.buckets.length > 0 ? key.buckets.join(", ") : "all buckets";
  return `${accessLabel} · ${scopeLabel}`;
}

// Expiry options as day counts; "never" ⇒ no expiration sent.
const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: "never", label: "No expiry" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

function expiryToIso(value: string): string | undefined {
  if (value === "never") return undefined;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function describeKeyExpiry(key: ManagedStorageAccessKey): string {
  if (!key.expiresAt) return "No expiry";
  return new Date(key.expiresAt).getTime() <= Date.now()
    ? "Expired"
    : `Expires ${formatDate(key.expiresAt)}`;
}

export function StorageIamKeysTab({
  managedId,
  engine = "minio",
  canManage,
}: {
  managedId: string;
  /** Older backends omit the engine; those clusters are MinIO. */
  engine?: ManagedStorageEngine;
  canManage: boolean;
}) {
  const [keys, setKeys] = useState<ManagedStorageAccessKey[]>([]);
  const [loading, setLoading] = useState(true);
  // Refreshes keep the list on screen; only the first load hides the tab.
  const [loaded, setLoaded] = useState(false);
  useContentLoading(!loaded);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyAccess, setNewKeyAccess] = useState<ManagedStorageAccessKeyAccess>("read-write");
  const [bucketScopeMode, setBucketScopeMode] = useState<BucketScopeMode>("all");
  const [bucketsRaw, setBucketsRaw] = useState("");
  const [newKeyExpiry, setNewKeyExpiry] = useState("never");
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{
    accessKeyId: string;
    secretKey: string;
  } | null>(null);
  const [createdSecretOpen, setCreatedSecretOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listManagedStorageAccessKeys(managedId);
      setKeys(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load access keys");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [managedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setNewKeyName("");
    setNewKeyAccess("read-write");
    setBucketScopeMode("all");
    setBucketsRaw("");
    setNewKeyExpiry("never");
    setCreateOpen(true);
  };

  const parsedBuckets = useMemo(() => parseBucketNames(bucketsRaw), [bucketsRaw]);
  const invalidBuckets = useMemo(
    () => parsedBuckets.filter((name) => !BUCKET_NAME_PATTERN.test(name)),
    [parsedBuckets]
  );
  const bucketsError =
    bucketScopeMode === "specific"
      ? parsedBuckets.length === 0
        ? "Enter at least one bucket name."
        : invalidBuckets.length > 0
          ? `Invalid bucket name${invalidBuckets.length > 1 ? "s" : ""}: ${invalidBuckets.join(", ")}. Use lowercase letters, numbers, dots and hyphens (3-63 chars, starting/ending alphanumeric).`
          : null
      : null;

  const handleCreate = async () => {
    if (bucketsError) return;
    setCreating(true);
    try {
      const result = await api.createManagedStorageAccessKey(managedId, {
        name: newKeyName.trim() || undefined,
        access: newKeyAccess,
        buckets: bucketScopeMode === "specific" ? parsedBuckets : undefined,
        expiresAt: expiryToIso(newKeyExpiry),
      });
      setCreatedSecret({ accessKeyId: result.accessKeyId, secretKey: result.secretKey });
      setCreateOpen(false);
      setCreatedSecretOpen(true);
      toast.success("Access key created");
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create access key");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ManagedStorageAccessKey) => {
    const ok = await confirm({
      title: "Revoke Access Key",
      description: `Revoke access key "${key.name || key.accessKeyId}"? Any application using it will immediately lose access.`,
      confirmLabel: "Revoke",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.removeManagedStorageAccessKey(managedId, key.accessKeyId);
      toast.success("Access key revoked");
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke access key");
    }
  };

  return (
    <>
      <PanelShell
        title="IAM access keys"
        description="Manage access to this storage."
        wrapHeader
        actions={
          <>
            <RefreshButton onClick={() => void load()} disabled={loading} />
            {canManage && (
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                Create key
              </Button>
            )}
          </>
        }
        bodyClassName="min-w-0"
      >
        {!loaded ? null : keys.length > 0 ? (
          <ResourceListFrame minWidth={900} className="border-0">
            <ResourceListHeaderTable columns={KEY_COLUMNS} />
            <ResourceListTable columns={KEY_COLUMNS}>
              {keys.map((key) => (
                <ResourceListRow key={key.accessKeyId}>
                  <ResourceListCell contentClassName="text-sm font-medium">
                    {key.name || "Unnamed key"}
                  </ResourceListCell>
                  <ResourceListCell>
                    <Badge variant="secondary" className="font-mono">
                      {key.accessKeyId}
                    </Badge>
                  </ResourceListCell>
                  <ResourceListCell contentClassName="text-xs text-muted-foreground">
                    {describeKeyScope(key)}
                  </ResourceListCell>
                  <ResourceListCell contentClassName="text-xs text-muted-foreground">
                    <RelativeTime value={key.createdAt} />
                  </ResourceListCell>
                  <ResourceListCell contentClassName="text-xs text-muted-foreground">
                    {describeKeyExpiry(key)}
                  </ResourceListCell>
                  <ResourceListCell align="right">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleRevoke(key)}
                        aria-label="Revoke access key"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </ResourceListCell>
                </ResourceListRow>
              ))}
            </ResourceListTable>
          </ResourceListFrame>
        ) : (
          <EmptyState
            message="No IAM access keys created yet."
            {...(canManage ? { actionLabel: "Create one", onAction: openCreate } : {})}
            embedded
          />
        )}
      </PanelShell>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Access Key</DialogTitle>
            <DialogDescription>
              {engine === "seaweedfs"
                ? "The access key ID and secret are generated for you — by Opfield for keys without an expiry. Only a display name is set here."
                : "The access key ID and secret are generated for you; only a display name is set here."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name (optional)</label>
              <Input
                value={newKeyName}
                onChange={(event) => setNewKeyName(event.target.value)}
                placeholder="e.g., Backup job"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Access</label>
              <Select
                value={newKeyAccess}
                onValueChange={(value) => setNewKeyAccess(value as ManagedStorageAccessKeyAccess)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="read-write"
                    description="Read and write objects in the scoped bucket(s)."
                  >
                    Read &amp; write
                  </SelectItem>
                  <SelectItem
                    value="read-only"
                    description="Read-only access to the scoped bucket(s)."
                  >
                    Read-only
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Bucket scope</label>
              <Select
                value={bucketScopeMode}
                onValueChange={(value) => setBucketScopeMode(value as BucketScopeMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="all"
                    description="Grants access to every bucket in this cluster."
                  >
                    All buckets
                  </SelectItem>
                  <SelectItem
                    value="specific"
                    description="Restrict access to a set of bucket names."
                  >
                    Specific buckets
                  </SelectItem>
                </SelectContent>
              </Select>
              {bucketScopeMode === "specific" && (
                <div className="space-y-1">
                  <Input
                    value={bucketsRaw}
                    onChange={(event) => setBucketsRaw(event.target.value)}
                    placeholder="e.g., artifacts, logs"
                    aria-invalid={bucketsError ? true : undefined}
                  />
                  <p className="text-xs text-muted-foreground">Comma-separated bucket names.</p>
                  {bucketsError && <p className="text-xs text-destructive">{bucketsError}</p>}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Expiry</label>
              <Select value={newKeyExpiry} onValueChange={setNewKeyExpiry}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {newKeyExpiry === "never"
                  ? "The key stays valid until it is revoked."
                  : "The storage engine enforces the expiry and rejects the key after it expires."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              pending={creating}
              disabled={!!bucketsError}
            >
              Create Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimeSecretDialog
        open={createdSecretOpen}
        onOpenChange={setCreatedSecretOpen}
        title="Access Key Created"
        description="S3 clients sign their requests with this key pair."
        fields={
          createdSecret
            ? [
                { label: "Access key ID", value: createdSecret.accessKeyId },
                { label: "Secret key", value: createdSecret.secretKey },
              ]
            : null
        }
        onClosed={() => setCreatedSecret(null)}
      />
    </>
  );
}
