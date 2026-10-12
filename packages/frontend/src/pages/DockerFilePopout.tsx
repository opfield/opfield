import { Check, ClipboardCopy, Download, Save } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Toaster } from "@/components/ui/sonner";
import { toastApiError } from "@/lib/api-error-toast";
import { codeEditorLanguageForFile, imageMimeForFile } from "@/lib/file-types";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

type ImageInfo = {
  blob: Blob;
  url: string;
};

type ImageTransform = {
  scale: number;
  x: number;
  y: number;
};

const MIN_IMAGE_SCALE = 1;
const MAX_IMAGE_SCALE = 8;
const IMAGE_WHEEL_ZOOM_SENSITIVITY = 0.0065;
const IMAGE_CLICK_ZOOM_SCALE = 2;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function copyImageBlobAsPng(blob: Blob) {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Image clipboard is not supported by this browser");
  }

  const sourceUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to prepare image for clipboard");
    context.drawImage(image, 0, 0);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error("Unable to prepare image for clipboard"));
      }, "image/png");
    });

    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export function DockerFilePopout() {
  const { nodeId, containerId, volumeName, storageId } = useParams<{
    nodeId: string;
    containerId?: string;
    volumeName?: string;
    storageId?: string;
  }>();
  const [searchParams] = useSearchParams();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const filePath = searchParams.get("path") || "/";
  const isWritable = searchParams.get("writable") === "1";
  const bucket = searchParams.get("bucket") || "";
  const isStorageFile = !!storageId;
  const isVolumeFile = !!volumeName;
  const isNodeFile = !containerId && !volumeName && !storageId;
  const resourceId = storageId ?? volumeName ?? containerId ?? nodeId;
  const canUseContainerFiles =
    !!nodeId && !!containerId && hasScopedAccess("docker:containers:files:read");
  const canWriteContainerFiles =
    !!nodeId && !!containerId && hasScopedAccess("docker:containers:files:write");
  const canUseVolumeFiles =
    !!nodeId &&
    !!volumeName &&
    (hasScope("docker:volumes:files:read") || hasScope(`docker:volumes:files:read:${nodeId}`));
  const canWriteVolumeFiles =
    !!nodeId &&
    !!volumeName &&
    (hasScope("docker:volumes:files:write") || hasScope(`docker:volumes:files:write:${nodeId}`));
  const canUseNodeFiles =
    !!nodeId &&
    isNodeFile &&
    (hasScope("nodes:files:read") || hasScope(`nodes:files:read:${nodeId}`));
  const canWriteNodeFiles =
    !!nodeId &&
    isNodeFile &&
    (hasScope("nodes:files:write") || hasScope(`nodes:files:write:${nodeId}`));
  const canUseStorageFiles =
    !!storageId &&
    !!bucket &&
    (hasScope("storage:objects:read") || hasScope(`storage:objects:read:${storageId}`));
  const canWriteStorageFiles =
    !!storageId &&
    !!bucket &&
    (hasScope("storage:objects:write") || hasScope(`storage:objects:write:${storageId}`));
  const canUseFiles = isStorageFile
    ? canUseStorageFiles
    : isNodeFile
      ? canUseNodeFiles
      : isVolumeFile
        ? canUseVolumeFiles
        : canUseContainerFiles;
  const canSaveFile =
    isWritable &&
    (isStorageFile
      ? canWriteStorageFiles
      : isNodeFile
        ? canWriteNodeFiles
        : isVolumeFile
          ? canWriteVolumeFiles
          : canWriteContainerFiles);

  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<ArrayBuffer | null>(null);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [imageTransform, setImageTransform] = useState<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const [isImageDragging, setIsImageDragging] = useState(false);
  const didFetch = useRef(false);
  const imageUrlRef = useRef<string | null>(null);
  const imageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageDragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(
    null
  );
  const ignoreNextImageClickRef = useRef(false);

  const hasChanges = content !== null && content !== savedContent;
  const isImage = imageInfo !== null;

  useEffect(() => {
    const fileName = filePath.split("/").pop() || filePath;
    document.title = `${fileName} — ${resourceId?.slice(0, 12)}`;
  }, [filePath, resourceId]);

  useEffect(() => {
    if (!canUseFiles) {
      setIsLoading(false);
      return;
    }
    if ((!nodeId && !storageId) || !resourceId || didFetch.current) return;
    didFetch.current = true;

    setIsLoading(true);
    const readFile = storageId
      ? api.readObject(storageId, bucket, filePath.replace(/^\//, ""))
      : isNodeFile
        ? api.readNodeFile(nodeId!, filePath)
        : isVolumeFile
          ? api.readVolumeFile(nodeId!, resourceId, filePath)
          : api.readContainerFile(nodeId!, resourceId, filePath);

    readFile
      .then((bytes) => {
        setFileBytes(bytes);
        const byteArray = new Uint8Array(bytes);
        const imageMime = imageMimeForFile(filePath, byteArray);
        if (imageMime) {
          const blob = new Blob([bytes], { type: imageMime });
          if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
          const url = URL.createObjectURL(blob);
          imageUrlRef.current = url;
          setImageInfo({ blob, url });
          setImageTransform({ scale: 1, x: 0, y: 0 });
          setIsImageDragging(false);
          imageDragRef.current = null;
          setContent(null);
          setSavedContent(null);
          return;
        }
        const text = new TextDecoder().decode(bytes);
        setContent(text);
        setSavedContent(text);
        if (imageUrlRef.current) {
          URL.revokeObjectURL(imageUrlRef.current);
          imageUrlRef.current = null;
        }
        setImageInfo(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to read file");
      })
      .finally(() => setIsLoading(false));
  }, [canUseFiles, nodeId, resourceId, filePath, isNodeFile, isVolumeFile, storageId, bucket]);

  useEffect(() => {
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  const fileName = filePath.split("/").pop() || "file";

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markCopied = () => {
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1000);
  };

  const handleCopy = () => {
    if (imageInfo) {
      copyImageBlobAsPng(imageInfo.blob).then(markCopied, (err) =>
        toastApiError(err, "Failed to copy image")
      );
      return;
    }
    if (content === null) return;
    navigator.clipboard.writeText(content).then(markCopied, () => toast.error("Failed to copy"));
  };

  const handleDownload = () => {
    if (fileBytes === null && content === null) return;
    const blob =
      imageInfo?.blob ??
      (fileBytes
        ? new Blob([fileBytes], { type: "application/octet-stream" })
        : new Blob([content ?? ""], { type: "text/plain" }));
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImageWheel = useCallback((event: globalThis.WheelEvent) => {
    const viewport = imageViewportRef.current;
    if (!viewport) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const offsetX = event.clientX - rect.left - rect.width / 2;
    const offsetY = event.clientY - rect.top - rect.height / 2;
    const zoomFactor = Math.exp(-event.deltaY * IMAGE_WHEEL_ZOOM_SENSITIVITY);

    setImageTransform((current) => {
      const nextScale = clamp(current.scale * zoomFactor, MIN_IMAGE_SCALE, MAX_IMAGE_SCALE);
      if (nextScale === MIN_IMAGE_SCALE) return { scale: MIN_IMAGE_SCALE, x: 0, y: 0 };

      const imagePointX = (offsetX - current.x) / current.scale;
      const imagePointY = (offsetY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: offsetX - imagePointX * nextScale,
        y: offsetY - imagePointY * nextScale,
      };
    });
  }, []);

  useEffect(() => {
    const viewport = imageViewportRef.current;
    if (!viewport || !imageInfo) return;

    viewport.addEventListener("wheel", handleImageWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleImageWheel);
  }, [handleImageWheel, imageInfo]);

  const handleImagePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (imageTransform.scale <= MIN_IMAGE_SCALE) return;
    imageDragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    setIsImageDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleImagePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = imageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    imageDragRef.current = {
      ...drag,
      x: event.clientX,
      y: event.clientY,
      moved: drag.moved || Math.abs(dx) > 1 || Math.abs(dy) > 1,
    };
    setImageTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const handleImagePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = imageDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    ignoreNextImageClickRef.current = drag.moved;
    imageDragRef.current = null;
    setIsImageDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resetImageTransform = () => {
    setIsImageDragging(false);
    setImageTransform({ scale: 1, x: 0, y: 0 });
  };

  const handleImageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (ignoreNextImageClickRef.current) {
      ignoreNextImageClickRef.current = false;
      return;
    }
    if (imageTransform.scale > MIN_IMAGE_SCALE) {
      resetImageTransform();
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left - rect.width / 2;
    const offsetY = event.clientY - rect.top - rect.height / 2;
    setImageTransform({
      scale: IMAGE_CLICK_ZOOM_SCALE,
      x: offsetX - offsetX * IMAGE_CLICK_ZOOM_SCALE,
      y: offsetY - offsetY * IMAGE_CLICK_ZOOM_SCALE,
    });
  };

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    if ((!nodeId && !storageId) || !resourceId || content === null || !canSaveFile) return;
    setIsSaving(true);
    try {
      if (storageId) {
        const key = filePath.replace(/^\//, "");
        const metadata = await api.getObjectMetadata(storageId, bucket, key);
        const contentType = metadata.contentType || "application/octet-stream";
        await api.uploadObject(storageId, {
          bucket,
          key,
          contentType,
          body: new Blob([content], { type: contentType }),
        });
      } else if (isVolumeFile) {
        await api.writeVolumeFile(nodeId!, resourceId, filePath, content);
      } else if (isNodeFile) {
        await api.writeNodeFile(nodeId!, filePath, content);
      } else {
        await api.writeContainerFile(nodeId!, resourceId, filePath, content);
      }
      setSavedContent(content);
      toast.success("File saved");
    } catch (err) {
      toastApiError(err, "Failed to save file");
    } finally {
      setIsSaving(false);
    }
  }, [
    canSaveFile,
    isSaving,
    nodeId,
    resourceId,
    filePath,
    content,
    isNodeFile,
    isVolumeFile,
    storageId,
    bucket,
  ]);

  if (!canUseFiles) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background px-4 text-sm text-muted-foreground">
        You don't have permission to access files.
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="flex items-center justify-between px-4 py-3 shrink-0 bg-card">
        <div>
          <h3 className="text-sm font-semibold">{fileName}</h3>
          <p className="text-xs text-muted-foreground font-mono">{filePath}</p>
        </div>
        {(content !== null || imageInfo !== null) && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={handleCopy} title="Copy">
              <Check
                className={`h-3.5 w-3.5 absolute transition-all duration-200 ${copied ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
              />
              <ClipboardCopy
                className={`h-3.5 w-3.5 transition-all duration-200 ${copied ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
              />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleDownload} title="Download">
              <Download className="h-3.5 w-3.5" />
            </Button>
            {canSaveFile && !isImage && (
              <Button onClick={handleSave} pending={isSaving} disabled={!hasChanges}>
                <Save className="h-3.5 w-3.5" />
                Save
              </Button>
            )}
          </div>
        )}
      </div>

      {isLoading ? (
        // A popout window has no page gate; the spinner fills the area the file will take.
        <LoadingSpinner className="min-h-0 flex-1" label="Reading file" />
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-destructive text-sm">
          {error}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {imageInfo ? (
            <div
              ref={imageViewportRef}
              className={`flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-background select-none ${
                imageTransform.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
              }`}
              onPointerDown={handleImagePointerDown}
              onPointerMove={handleImagePointerMove}
              onPointerUp={handleImagePointerUp}
              onPointerCancel={handleImagePointerUp}
              onClick={handleImageClick}
              style={{ touchAction: "none" }}
            >
              <img
                src={imageInfo.url}
                alt={fileName}
                className={`max-h-full max-w-full object-contain ${
                  isImageDragging ? "" : "transition-transform duration-75 ease-out"
                }`}
                draggable={false}
                style={{
                  transform: `translate3d(${imageTransform.x}px, ${imageTransform.y}px, 0) scale(${imageTransform.scale})`,
                  transformOrigin: "center",
                }}
              />
            </div>
          ) : (
            <CodeEditor
              value={content ?? ""}
              onChange={isWritable ? setContent : () => {}}
              readOnly={!isWritable}
              language={codeEditorLanguageForFile(filePath)}
            />
          )}
        </div>
      )}
      <Toaster position="bottom-right" />
    </div>
  );
}
