import { HardDrive } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { formatBytes } from "@/lib/utils";
import type { DockerVolumeMetrics } from "@/types";

/**
 * A volume's disk usage: used space for a regular volume; used / capacity, the percent and a progress bar for a
 * disk-image volume. Shared by the volume detail page and container monitoring.
 */
export function VolumeSpaceStatCard({
  metrics,
  history,
  label = "Space",
}: {
  metrics: DockerVolumeMetrics | null;
  /** Recent used-byte samples for the sparkline. */
  history: number[];
  label?: string;
}) {
  return (
    <StatCard
      label={label}
      value={
        metrics?.usedBytes == null
          ? "N/A"
          : metrics.capacityBytes != null
            ? `${formatBytes(metrics.usedBytes)} / ${formatBytes(metrics.capacityBytes)}`
            : formatBytes(metrics.usedBytes)
      }
      icon={HardDrive}
      history={history.length ? history : [0]}
      color="var(--color-hue-blue)"
      sparklineMax={metrics?.capacityBytes ?? undefined}
      progress={
        metrics?.usedBytes != null && metrics.capacityBytes
          ? { percent: Math.min(100, (metrics.usedBytes / metrics.capacityBytes) * 100) }
          : undefined
      }
      subtitle={
        metrics?.availableBytes != null
          ? `${formatBytes(metrics.availableBytes)} available`
          : metrics?.usedBytes != null
            ? "Capacity is shared with the node"
            : "Unavailable"
      }
    />
  );
}
