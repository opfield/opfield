import { Gauge, MemoryStick, Thermometer, Zap } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { formatBytes } from "@/lib/utils";
import { gpuDeviceLabel, hasGpuMetric, type NodeGpuDevice } from "@/types";

type MetricHistory = (
  metric: string,
  value: (device: NodeGpuDevice) => number | undefined
) => number[];

function gpuColor(vendor: string) {
  if (vendor === "nvidia") return "var(--color-hue-green)";
  if (vendor === "amd") return "var(--color-hue-red)";
  if (vendor === "intel") return "var(--color-hue-blue)";
  return "var(--color-hue-slate)";
}

export function gpuTemperatureProgressPercent(temperatureCelsius: number | undefined) {
  const temperature =
    typeof temperatureCelsius === "number" && Number.isFinite(temperatureCelsius)
      ? temperatureCelsius
      : 0;
  return Math.min(100, Math.max(0, ((temperature - 20) / (100 - 20)) * 100));
}

export function GpuMonitoringSection({
  gpu,
  index,
  history,
}: {
  gpu: NodeGpuDevice;
  index: number;
  history: MetricHistory;
}) {
  const color = gpuColor(gpu.vendor);
  const utilizationAvailable = hasGpuMetric(gpu, "utilization_percent");
  const vramAvailable =
    hasGpuMetric(gpu, "memory_total_bytes") &&
    hasGpuMetric(gpu, "memory_used_bytes") &&
    (gpu.memoryTotalBytes ?? 0) > 0;
  const temperatureAvailable = hasGpuMetric(gpu, "temperature_celsius");
  const powerAvailable =
    hasGpuMetric(gpu, "power_watts") &&
    hasGpuMetric(gpu, "power_limit_watts") &&
    (gpu.powerLimitWatts ?? 0) > 0;
  const vramPercent = ((gpu.memoryUsedBytes ?? 0) / (gpu.memoryTotalBytes ?? 1)) * 100;
  const temperaturePercent = gpuTemperatureProgressPercent(gpu.temperatureCelsius);
  const powerPercent = ((gpu.powerWatts ?? 0) / (gpu.powerLimitWatts ?? 1)) * 100;

  return (
    <section>
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-muted-foreground">
          GPU {index + 1} · {gpuDeviceLabel(gpu)}
        </h3>
        <p className="text-xs text-muted-foreground">
          {gpu.id}
          {gpu.pciAddress ? ` · ${gpu.pciAddress}` : ""}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        <StatCard
          label="Utilization"
          value={
            utilizationAvailable ? `${(gpu.utilizationPercent ?? 0).toFixed(1)}%` : "Unavailable"
          }
          icon={Gauge}
          history={history("utilization_percent", (device) => device.utilizationPercent)}
          sparklineMax={100}
          color={color}
          progress={
            utilizationAvailable ? { percent: gpu.utilizationPercent ?? 0, color } : undefined
          }
        />
        <StatCard
          label="VRAM"
          value={vramAvailable ? formatBytes(gpu.memoryUsedBytes ?? 0) : "Unavailable"}
          icon={MemoryStick}
          history={history("memory_used_bytes", (device) => device.memoryUsedBytes)}
          sparklineMax={vramAvailable ? gpu.memoryTotalBytes : undefined}
          color="var(--color-hue-violet)"
          progress={
            vramAvailable ? { percent: vramPercent, color: "var(--color-hue-violet)" } : undefined
          }
          subtitle={
            vramAvailable
              ? `${vramPercent.toFixed(1)}% of ${formatBytes(gpu.memoryTotalBytes ?? 0)}`
              : "Not reported by this GPU"
          }
        />
        <StatCard
          label="Temperature"
          value={
            temperatureAvailable ? `${(gpu.temperatureCelsius ?? 0).toFixed(1)}°C` : "Unavailable"
          }
          icon={Thermometer}
          history={history("temperature_celsius", (device) => device.temperatureCelsius)}
          sparklineMax={100}
          color="var(--color-hue-orange)"
          progress={
            temperatureAvailable
              ? { percent: temperaturePercent, color: "var(--color-hue-orange)" }
              : undefined
          }
          subtitle={
            temperatureAvailable
              ? `${temperaturePercent.toFixed(1)}% of 20–100°C`
              : "Not reported by this GPU"
          }
        />
        <StatCard
          label="Power"
          value={powerAvailable ? `${(gpu.powerWatts ?? 0).toFixed(1)} W` : "Unavailable"}
          icon={Zap}
          history={history("power_watts", (device) => device.powerWatts)}
          sparklineMax={powerAvailable ? gpu.powerLimitWatts : undefined}
          color="var(--color-hue-amber)"
          progress={
            powerAvailable ? { percent: powerPercent, color: "var(--color-hue-amber)" } : undefined
          }
          subtitle={
            powerAvailable
              ? `${powerPercent.toFixed(1)}% of ${(gpu.powerLimitWatts ?? 0).toFixed(1)} W`
              : "Not reported by this GPU"
          }
        />
      </div>
    </section>
  );
}
