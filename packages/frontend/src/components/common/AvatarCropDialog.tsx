import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { cn } from "@/lib/utils";

const DEFAULT_PREVIEW_SIZE = 320;
const MAX_AVATAR_BYTES = 1024 * 1024;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

interface ImageDimensions {
  width: number;
  height: number;
}

interface AvatarOffset {
  x: number;
  y: number;
}

export function clampAvatarOffset({
  offset,
  image,
  previewSize,
  zoom,
}: {
  offset: AvatarOffset;
  image: ImageDimensions;
  previewSize: number;
  zoom: number;
}): AvatarOffset {
  if (!image.width || !image.height || !previewSize) return { x: 0, y: 0 };
  const baseScale = Math.max(previewSize / image.width, previewSize / image.height);
  const displayedWidth = image.width * baseScale * zoom;
  const displayedHeight = image.height * baseScale * zoom;
  const maxX = Math.max(0, (displayedWidth - previewSize) / 2);
  const maxY = Math.max(0, (displayedHeight - previewSize) / 2);
  return {
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, offset.x)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, offset.y)),
  };
}

export function calculateAvatarCropRect({
  image,
  previewSize,
  zoom,
  offset,
}: {
  image: ImageDimensions;
  previewSize: number;
  zoom: number;
  offset: AvatarOffset;
}) {
  const baseScale = Math.max(previewSize / image.width, previewSize / image.height);
  const scale = baseScale * zoom;
  const displayedWidth = image.width * scale;
  const displayedHeight = image.height * scale;
  const sourceSize = previewSize / scale;
  const sourceX = Math.max(
    0,
    Math.min(
      image.width - sourceSize,
      (displayedWidth - previewSize) / (2 * scale) - offset.x / scale
    )
  );
  const sourceY = Math.max(
    0,
    Math.min(
      image.height - sourceSize,
      (displayedHeight - previewSize) / (2 * scale) - offset.y / scale
    )
  );
  return { sourceX, sourceY, sourceSize };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode avatar image"))),
      type,
      quality
    );
  });
}

async function createCroppedAvatarBlob({
  imageElement,
  image,
  previewSize,
  zoom,
  offset,
}: {
  imageElement: HTMLImageElement;
  image: ImageDimensions;
  previewSize: number;
  zoom: number;
  offset: AvatarOffset;
}): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image editing is unavailable in this browser");

  const { sourceX, sourceY, sourceSize } = calculateAvatarCropRect({
    image,
    previewSize,
    zoom,
    offset,
  });
  const outputSizes = [512, 384, 320, 256];
  const qualities = [0.92, 0.84, 0.76, 0.68, 0.6, 0.52];

  for (const outputSize of outputSizes) {
    canvas.width = outputSize;
    canvas.height = outputSize;
    context.clearRect(0, 0, outputSize, outputSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      imageElement,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      outputSize,
      outputSize
    );

    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, "image/webp", quality);
      if (blob.size <= MAX_AVATAR_BYTES) return blob;
    }
  }

  throw new Error("The cropped avatar is still too large. Try a simpler or smaller image.");
}

export function AvatarCropDialog({
  file,
  open,
  uploading,
  onOpenChange,
  onUpload,
  title = "Adjust Avatar",
}: {
  /** Dialog title; app logos use "Adjust Logo". */
  title?: string;
  file: File | null;
  open: boolean;
  uploading: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (avatar: Blob) => Promise<boolean>;
}) {
  const displayedFile = useRetainedDialogValue(file, open);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    offset: AvatarOffset;
  } | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [previewElement, setPreviewElement] = useState<HTMLDivElement | null>(null);
  const [previewSize, setPreviewSize] = useState(DEFAULT_PREVIEW_SIZE);
  const [image, setImage] = useState<ImageDimensions>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<AvatarOffset>({ x: 0, y: 0 });
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!displayedFile) {
      setSourceUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(displayedFile);
    setSourceUrl(nextUrl);
    setImage({ width: 0, height: 0 });
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    setError(null);
    return () => URL.revokeObjectURL(nextUrl);
  }, [displayedFile]);

  const previewRef = useCallback((element: HTMLDivElement | null) => {
    setPreviewElement(element);
  }, []);

  useLayoutEffect(() => {
    if (!open || !previewElement) return;
    const updateSize = () => setPreviewSize(previewElement.clientWidth || DEFAULT_PREVIEW_SIZE);
    updateSize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateSize);
    observer?.observe(previewElement);
    window.addEventListener("resize", updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, [open, previewElement]);

  useEffect(() => {
    setOffset((current) => clampAvatarOffset({ offset: current, image, previewSize, zoom }));
  }, [image, previewSize, zoom]);

  const displaySize = useMemo(() => {
    if (!image.width || !image.height) return { width: previewSize, height: previewSize };
    const baseScale = Math.max(previewSize / image.width, previewSize / image.height);
    return {
      width: image.width * baseScale * zoom,
      height: image.height * baseScale * zoom,
    };
  }, [image, previewSize, zoom]);

  const moveBy = (x: number, y: number) => {
    setOffset((current) =>
      clampAvatarOffset({
        offset: { x: current.x + x, y: current.y + y },
        image,
        previewSize,
        zoom,
      })
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!image.width || uploading || processing) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(
      clampAvatarOffset({
        offset: {
          x: drag.offset.x + event.clientX - drag.startX,
          y: drag.offset.y + event.clientY - drag.startY,
        },
        image,
        previewSize,
        zoom,
      })
    );
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleCropKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const distance = event.shiftKey ? 24 : 8;
    const movement = {
      ArrowLeft: [distance, 0],
      ArrowRight: [-distance, 0],
      ArrowUp: [0, distance],
      ArrowDown: [0, -distance],
    }[event.key];
    if (!movement) return;
    event.preventDefault();
    moveBy(movement[0], movement[1]);
  };

  const setClampedZoom = (nextZoom: number) => {
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom)));
  };

  const upload = async () => {
    const imageElement = imageRef.current;
    if (!imageElement || !image.width || !image.height) return;
    setProcessing(true);
    setError(null);
    try {
      const avatar = await createCroppedAvatarBlob({
        imageElement,
        image,
        previewSize,
        zoom,
        offset,
      });
      if (await onUpload(avatar)) onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to prepare avatar");
    } finally {
      setProcessing(false);
    }
  };

  const busy = uploading || processing;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <DialogDescription>
            Drag the image to reposition it, then adjust the zoom.
          </DialogDescription>
          <div
            ref={previewRef}
            role="application"
            tabIndex={0}
            aria-label="Avatar crop area. Drag the image or use the arrow keys to reposition it."
            className={cn(
              "relative aspect-square w-full touch-none overflow-hidden border border-border bg-muted outline-none",
              "cursor-grab focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing",
              busy && "pointer-events-none opacity-60"
            )}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onKeyDown={handleCropKeyDown}
          >
            {sourceUrl && (
              <img
                ref={imageRef}
                src={sourceUrl}
                alt="Avatar crop preview"
                draggable={false}
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
                style={{
                  width: displaySize.width,
                  height: displaySize.height,
                  transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
                }}
                onLoad={(event) => {
                  setImage({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                }}
              />
            )}
            <div className="pointer-events-none absolute inset-0 border-[3px] border-background/80 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-scrim)_40%,transparent)]" />
            <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-on-scrim/25" />
            <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-on-scrim/25" />
            <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-on-scrim/25" />
            <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-on-scrim/25" />
          </div>

          <div className="px-2">
            <Slider
              value={zoom}
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              disabled={busy}
              ariaLabel="Zoom"
              className="min-w-0 flex-1"
              onValueChange={setClampedZoom}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            pending={busy}
            disabled={!image.width}
            onClick={() => void upload()}
          >
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
