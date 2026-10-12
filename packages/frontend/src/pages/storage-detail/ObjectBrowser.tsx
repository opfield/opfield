import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { useContentLoading } from "@/components/common/reveal-gate";
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
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import {
  isFileProtocolProvider,
  type ObjectStorageBucket,
  type ObjectStorageConnection,
} from "@/types";
import { FilesTab } from "../docker-detail/FilesTab";
import { storageFileOperations } from "./storage-file-operations";

export function ObjectBrowser({
  storage,
  canWrite,
  canCreateBuckets,
}: {
  storage: ObjectStorageConnection;
  canWrite: boolean;
  /** storage:objects:admin: the API creates and deletes buckets only with it. */
  canCreateBuckets: boolean;
}) {
  const [buckets, setBuckets] = useState<ObjectStorageBucket[]>([]);
  const [bucket, setBucket] = useState(storage.defaultBucket ?? "");
  const [bucketsLoading, setBucketsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [newBucketName, setNewBucketName] = useState("");
  const [creatingBucket, setCreatingBucket] = useState(false);
  // The tab reveals with the bucket list; a later retry shows the spinner in place.
  useContentLoading(bucketsLoading);
  const loadBuckets = useCallback(async () => {
    setBucketsLoading(true);
    try {
      const result = await api.listBuckets(storage.id);
      setBuckets(result);
      setLoadError(null);
      setBucket((current) =>
        result.some((entry) => entry.name === current) ? current : (result[0]?.name ?? "")
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load buckets");
    } finally {
      setBucketsLoading(false);
    }
  }, [storage.id]);
  useEffect(() => {
    void loadBuckets();
  }, [loadBuckets]);
  const operations = useMemo(
    () => storageFileOperations(storage.id, bucket, canWrite),
    [storage.id, bucket, canWrite]
  );
  const createBucket = async () => {
    if (!newBucketName.trim() || creatingBucket) return;
    setCreatingBucket(true);
    try {
      const name = newBucketName.trim();
      await api.createBucket(storage.id, name);
      toast.success("Bucket created");
      setNewBucketOpen(false);
      await loadBuckets();
      setBucket(name);
    } catch (error) {
      toastApiError(error, "Failed to create bucket");
    } finally {
      setCreatingBucket(false);
    }
  };
  const openNewBucket = () => {
    setNewBucketName("");
    setNewBucketOpen(true);
  };
  const actions = (
    <>
      <Select value={bucket} onValueChange={setBucket} disabled={bucketsLoading}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Select bucket" />
        </SelectTrigger>
        <SelectContent>
          {buckets.map((entry) => (
            <SelectItem key={entry.name} value={entry.name}>
              {entry.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RefreshButton
        onClick={async () => {
          await loadBuckets();
          setRevision((value) => value + 1);
        }}
        disabled={bucketsLoading}
      />
      {canCreateBuckets && !isFileProtocolProvider(storage.provider) && (
        <Button onClick={openNewBucket}>
          <Plus className="h-4 w-4" />
          New bucket
        </Button>
      )}
    </>
  );
  return (
    <>
      {bucket ? (
        <FilesTab
          key={`${bucket}:${revision}`}
          description="Browse and manage files in the selected bucket"
          nodeId=""
          canBrowse
          canWrite={canWrite}
          operations={operations}
          realtimeEvent={null}
          headerActions={actions}
        />
      ) : bucketsLoading ? (
        <LoadingSpinner />
      ) : (
        <EmptyState
          message={loadError ?? "No buckets yet."}
          actionLabel={loadError ? "Retry" : canCreateBuckets ? "Create bucket" : undefined}
          onAction={
            loadError ? () => void loadBuckets() : canCreateBuckets ? openNewBucket : undefined
          }
        />
      )}
      <Dialog open={newBucketOpen} onOpenChange={setNewBucketOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Bucket</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Buckets are the top level of this storage. Objects always live inside one.
          </DialogDescription>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Bucket name</label>
            <Input
              value={newBucketName}
              onChange={(e) => setNewBucketName(e.target.value)}
              placeholder="assets"
              onKeyDown={(e) => {
                if (e.key === "Enter") void createBucket();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewBucketOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void createBucket()}
              pending={creatingBucket}
              disabled={!newBucketName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
