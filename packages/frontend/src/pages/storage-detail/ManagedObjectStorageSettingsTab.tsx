import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import type { ObjectStorageConnection } from "@/types";
import {
  managedStorageEngine,
  managedStorageErrorMessage,
  managedStorageMinimumMemoryMb,
} from "./managed-storage-engine";

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

export function ManagedObjectStorageSettingsTab({
  storage,
  onSaved,
}: {
  storage: ObjectStorageConnection;
  onSaved: () => void;
}) {
  const managed = storage.managed!;
  const engine = managedStorageEngine(storage) ?? "minio";
  const minimumMemoryMb = managedStorageMinimumMemoryMb(engine);
  const [name, setName] = useState(storage.name);
  const [tags, setTags] = useState(storage.tags.join(", "));
  const [cpuCores, setCpuCores] = useState(String(managed.runtimeConfig.cpuCores || 1));
  const [memoryMb, setMemoryMb] = useState(
    String(Math.max(minimumMemoryMb, managed.runtimeConfig.memoryMb))
  );
  const [swapMb, setSwapMb] = useState(String(Math.max(0, managed.runtimeConfig.swapMb)));
  const [publishS3, setPublishS3] = useState(managed.publishS3 ?? false);
  const [publishedPort, setPublishedPort] = useState(String(managed.publishedPort));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(storage.name);
    setTags(storage.tags.join(", "));
    setCpuCores(String(managed.runtimeConfig.cpuCores || 1));
    setMemoryMb(String(Math.max(minimumMemoryMb, managed.runtimeConfig.memoryMb)));
    setSwapMb(String(Math.max(0, managed.runtimeConfig.swapMb)));
    setPublishS3(managed.publishS3 ?? false);
    setPublishedPort(String(managed.publishedPort));
  }, [storage.name, storage.tags, managed, minimumMemoryMb]);

  const requestedPort = Number(publishedPort);
  const portIsValid =
    publishedPort.trim().length > 0 &&
    Number.isInteger(requestedPort) &&
    requestedPort >= 1 &&
    requestedPort <= 65535;

  const save = async () => {
    const cpu = Number(cpuCores);
    const memory = Number(memoryMb);
    const swap = Number(swapMb);
    if (
      !name.trim() ||
      !(cpu > 0) ||
      !Number.isInteger(memory) ||
      memory < minimumMemoryMb ||
      !Number.isInteger(swap) ||
      swap < 0 ||
      !portIsValid
    ) {
      toast.error("Enter valid managed storage settings");
      return;
    }
    setSaving(true);
    try {
      await api.updateManagedObjectStorage(managed.id, {
        name: name.trim(),
        tags: parseTags(tags),
        cpuCores: cpu,
        memoryMb: memory,
        swapMb: swap,
        publishedPort: requestedPort,
        publishS3,
      });
      toast.success("Managed storage settings updated");
      onSaved();
    } catch (error) {
      toast.error(managedStorageErrorMessage(error, "Failed to update managed storage"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatedHeight>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="managed-storage-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="managed-storage-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="managed-storage-tags" className="text-sm font-medium">
            Tags
          </label>
          <Input
            id="managed-storage-tags"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="team, red:production, green:analytics"
            disabled={saving}
          />
          <p className="text-xs text-muted-foreground">
            Use color:name for colored tags. Supported colors: blue, red, green, yellow, purple,
            pink, orange, gray.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="managed-storage-cpu" className="text-sm font-medium">
              CPU cores
            </label>
            <Input
              id="managed-storage-cpu"
              type="number"
              min={0.1}
              step={0.1}
              value={cpuCores}
              onChange={(event) => setCpuCores(event.target.value)}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="managed-storage-memory" className="text-sm font-medium">
              Memory, MB
            </label>
            <Input
              id="managed-storage-memory"
              type="number"
              min={minimumMemoryMb}
              value={memoryMb}
              onChange={(event) => setMemoryMb(event.target.value)}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="managed-storage-swap" className="text-sm font-medium">
              Swap, MB
            </label>
            <Input
              id="managed-storage-swap"
              type="number"
              min={0}
              value={swapMb}
              onChange={(event) => setSwapMb(event.target.value)}
              disabled={saving}
            />
          </div>
        </div>

        <SwitchCard
          label="Publish S3 endpoint"
          description="Private access remains available through Opfield relay."
          checked={publishS3}
          onCheckedChange={setPublishS3}
          disabled={saving}
        />
        <div className="space-y-1.5">
          <label htmlFor="managed-storage-published-port" className="text-sm font-medium">
            Published S3 API port
          </label>
          <Input
            id="managed-storage-published-port"
            aria-label="Published S3 API port"
            type="number"
            min={1}
            max={65535}
            value={publishedPort}
            onChange={(event) => setPublishedPort(event.target.value)}
            disabled={saving}
          />
          <p className="text-xs text-muted-foreground">
            Turning publication on or off, or changing the published port, recreates the storage
            container; its data is retained.
            {engine === "minio" &&
              " A legacy MinIO cluster can be recreated only while its image is still on the node."}
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => void save()} pending={saving} disabled={!portIsValid}>
            Save Changes
          </Button>
        </DialogFooter>
      </div>
    </AnimatedHeight>
  );
}
