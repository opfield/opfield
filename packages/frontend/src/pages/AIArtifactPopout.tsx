import { Check, ClipboardCopy, Download } from "lucide-react";
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
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Toaster } from "@/components/ui/sonner";
import { toastApiError } from "@/lib/api-error-toast";
import { codeEditorLanguageForFile, imageMimeForFile } from "@/lib/file-types";

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

const TEXT_PREVIEW_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "ini",
  "conf",
  "cfg",
  "cnf",
  "yaml",
  "yml",
  "json",
  "jsonl",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "html",
  "xml",
  "sh",
  "bash",
  "zsh",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "php",
  "sql",
  "log",
  "env",
  "pem",
  "crt",
  "csr",
  "key",
  "toml",
  "dockerfile",
]);

const CODE_PREVIEW_MEDIA_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);

function isTextPreviewFile(filename: string, mediaType: string | null) {
  const normalizedMediaType = mediaType?.toLowerCase() ?? "";
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return (
    normalizedMediaType.startsWith("text/") ||
    CODE_PREVIEW_MEDIA_TYPES.has(normalizedMediaType) ||
    TEXT_PREVIEW_EXTENSIONS.has(extension)
  );
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

export function AIArtifactPopout() {
  const { artifactId } = useParams<{ artifactId: string }>();
  const [searchParams] = useSearchParams();
  const filename = searchParams.get("filename") || "artifact";
  const mediaType = searchParams.get("mediaType");
  const [content, setContent] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<ArrayBuffer | null>(null);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  useContentLoading(isLoading);
  const [copied, setCopied] = useState(false);
  const [imageTransform, setImageTransform] = useState<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const [isImageDragging, setIsImageDragging] = useState(false);
  const imageUrlRef = useRef<string | null>(null);
  const imageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageDragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(
    null
  );
  const ignoreNextImageClickRef = useRef(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.title = `${filename} — artifact`;
  }, [filename]);

  useEffect(() => {
    if (!artifactId) {
      setError("Artifact id is missing");
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetch(`/api/ai/sandbox/artifacts/${encodeURIComponent(artifactId)}/download`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load artifact");
        const bytes = await response.arrayBuffer();
        setFileBytes(bytes);

        const byteArray = new Uint8Array(bytes);
        const imageMime = imageMimeForFile(filename, byteArray);
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
          return;
        }

        if (!isTextPreviewFile(filename, mediaType)) {
          setError("Preview is not available for this file.");
          return;
        }

        setContent(new TextDecoder().decode(bytes));
        setImageInfo(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load artifact");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [artifactId, filename, mediaType]);

  useEffect(() => {
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const markCopied = () => {
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1000);
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
        ? new Blob([fileBytes], { type: mediaType ?? "application/octet-stream" })
        : new Blob([content ?? ""], { type: mediaType ?? "text/plain" }));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
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

  const hasPreview = content !== null || imageInfo !== null;

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between bg-card px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{filename}</h3>
          <p className="truncate text-xs text-muted-foreground">{mediaType ?? "Artifact"}</p>
        </div>
        {hasPreview && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={handleCopy} title="Copy" aria-label="Copy">
              <Check
                className={`absolute h-3.5 w-3.5 transition-all duration-200 ${copied ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
              />
              <ClipboardCopy
                className={`h-3.5 w-3.5 transition-all duration-200 ${copied ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDownload}
              title="Download"
              aria-label="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div
          className="flex min-h-0 flex-1 flex-col gap-4 p-4"
          aria-busy="true"
          aria-label="Reading artifact"
        ></div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-sm text-muted-foreground">
          <p>{error}</p>
          {fileBytes !== null && (
            <Button variant="outline" onClick={handleDownload}>
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {imageInfo ? (
            <div
              ref={imageViewportRef}
              className={`flex min-h-0 flex-1 select-none items-center justify-center overflow-hidden bg-background ${
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
                alt={filename}
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
              onChange={() => {}}
              readOnly
              language={codeEditorLanguageForFile(filename, mediaType)}
            />
          )}
        </div>
      )}
      <Toaster position="bottom-right" />
    </div>
  );
}
