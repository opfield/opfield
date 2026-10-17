/** The `web-uploads` volume on apps-1, mounted by the `web` container. */
import { HttpResponse, http } from "msw";
import type { DockerVolume, DockerVolumeMetrics } from "@/types";
import { wrapped } from "../../handlers";
import { ago } from "../time";
import { apps1, volumeRows } from "./data";
import { volumeFiles } from "./runtime";

const GiB = 1024 ** 3;

const row = volumeRows.find((item) => item.nodeId === apps1.id && item.name === "web-uploads")!;

export const webUploadsVolume: DockerVolume = {
  ...row,
  labels: {
    "com.example.backup": "nightly",
    "net.opfield.managed": "true",
  },
  options: {},
};

export const webUploadsMetrics: DockerVolumeMetrics = {
  storageKind: "regular",
  usedBytes: Math.round(3.8 * GiB),
  capacityBytes: null,
  availableBytes: Math.round(58.2 * GiB),
  usedInodes: 18_412,
  totalInodes: 6_553_600,
  runningAttachmentCount: 1,
  collectedAt: ago(40, "s"),
};

export function dockerVolumeHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  const isWebUploads = (params: Record<string, unknown>) =>
    params.nodeId === apps1.id && params.name === "web-uploads";
  return [
    http.get("*/api/docker/nodes/:nodeId/volumes/:name/metrics", ({ params }) =>
      isWebUploads(params) ? wrapped(webUploadsMetrics) : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/volumes/:name/files", ({ params, request }) => {
      if (!isWebUploads(params)) return notFound();
      const path = new URL(request.url).searchParams.get("path") ?? "/";
      return wrapped(volumeFiles[path] ?? volumeFiles["/"]);
    }),
    http.get("*/api/docker/nodes/:nodeId/volumes/:name", ({ params }) =>
      isWebUploads(params) ? wrapped(webUploadsVolume) : notFound()
    ),
  ];
}
