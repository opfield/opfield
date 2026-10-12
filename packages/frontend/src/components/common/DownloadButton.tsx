import { Check, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Saves a PEM value as a file; sits in an input group next to a CopyButton. */
export function DownloadButton({
  value,
  label,
  filename,
}: {
  value: string;
  label: string;
  filename: string;
}) {
  const [downloaded, setDownloaded] = useState(false);
  const downloadedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (downloadedTimerRef.current !== null) window.clearTimeout(downloadedTimerRef.current);
    },
    []
  );

  const handleDownload = () => {
    const url = URL.createObjectURL(new Blob([value], { type: "application/x-pem-file" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);

    setDownloaded(true);
    toast.success("Downloaded");
    if (downloadedTimerRef.current !== null) window.clearTimeout(downloadedTimerRef.current);
    downloadedTimerRef.current = window.setTimeout(() => {
      setDownloaded(false);
      downloadedTimerRef.current = null;
    }, 2000);
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative shrink-0 rounded-none border-l border-border bg-header text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={handleDownload}
      aria-label={`Download ${label}`}
      title={downloaded ? "Downloaded" : `Download ${label}`}
    >
      <Check
        className={`absolute h-4 w-4 transition-all duration-200 ${downloaded ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
      />
      <Download
        className={`h-4 w-4 transition-all duration-200 ${downloaded ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
      />
    </Button>
  );
}
