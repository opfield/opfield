import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ManagedObjectStorage, ManagedStorageBindingEnvironment } from "@/types";

const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_ENVIRONMENT: ManagedStorageBindingEnvironment = {
  endpoint: "S3_ENDPOINT",
  accessKeyId: "AWS_ACCESS_KEY_ID",
  secretAccessKey: "AWS_SECRET_ACCESS_KEY",
  bucket: "S3_BUCKET",
  region: "AWS_REGION",
};

const ENVIRONMENT_FIELDS: Array<{
  field: keyof ManagedStorageBindingEnvironment;
  label: string;
}> = [
  { field: "endpoint", label: "Endpoint" },
  { field: "accessKeyId", label: "Access key" },
  { field: "secretAccessKey", label: "Secret key" },
  { field: "bucket", label: "Bucket" },
  { field: "region", label: "Region" },
];

function hasCompleteEnvironment(environment: ManagedStorageBindingEnvironment) {
  const names = Object.values(environment)
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
  return (
    names.length > 0 &&
    names.every((name) => ENVIRONMENT_VARIABLE.test(name)) &&
    new Set(names).size === names.length
  );
}

export function ManagedStorageLinkDialog({
  open,
  onOpenChange,
  clusters,
  containerName,
  onStage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusters: ManagedObjectStorage[];
  containerName: string;
  onStage: (input: {
    clusterId: string;
    buckets: string[];
    environment: ManagedStorageBindingEnvironment;
  }) => void;
}) {
  const [clusterId, setClusterId] = useState("");
  const [buckets, setBuckets] = useState("");
  const [environment, setEnvironment] =
    useState<ManagedStorageBindingEnvironment>(DEFAULT_ENVIRONMENT);

  useEffect(() => {
    if (!open) return;
    setClusterId(clusters[0]?.id ?? "");
    setBuckets("");
    setEnvironment(DEFAULT_ENVIRONMENT);
  }, [clusters, open]);

  const bucketList = buckets
    .split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Managed Storage Link</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {containerName} will reach this cluster through a private connector. Credentials are
          stored as managed Docker secrets.
        </DialogDescription>

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Storage</span>
            <Select value={clusterId} onValueChange={setClusterId}>
              <SelectTrigger>
                <SelectValue placeholder="Select managed storage" />
              </SelectTrigger>
              <SelectContent>
                {clusters.map((cluster) => (
                  <SelectItem key={cluster.id} value={cluster.id}>
                    {cluster.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Buckets</span>
            <Input
              value={buckets}
              onChange={(event) => setBuckets(event.target.value)}
              placeholder="assets, uploads"
            />
            <span className="block text-xs text-muted-foreground">
              Comma-separated. The link's key can access only these buckets.
            </span>
          </label>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">Managed secret names</span>
            <div className="grid gap-2 md:grid-cols-2">
              {ENVIRONMENT_FIELDS.map(({ field, label }) => (
                <label
                  key={field}
                  className={cn("block space-y-1.5", field === "region" && "md:col-span-2")}
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Input
                    value={environment[field] ?? ""}
                    onChange={(event) =>
                      setEnvironment((current) => ({ ...current, [field]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Clear a name to skip it. Names must be unique and cannot collide with environment
              variables, secrets, or another managed link.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => onStage({ clusterId, buckets: bucketList, environment })}
            disabled={!clusterId || bucketList.length === 0 || !hasCompleteEnvironment(environment)}
          >
            Add link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
