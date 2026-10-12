import { AppWindow } from "lucide-react";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { cn } from "@/lib/utils";

/**
 * An app's mark: its uploaded logo, or the AppWindow icon tile. `md` (40 px) for list rows, `lg`
 * (48 px) for the page header; `sm` (36 px) matches the controls next to it in Settings.
 */
export function AppMark({
  logoUrl,
  size = "md",
}: {
  logoUrl?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const box = size === "sm" ? "h-9 w-9" : size === "lg" ? "h-12 w-12" : "h-10 w-10";
  if (logoUrl) return <img src={logoUrl} alt="" className={cn(box, "shrink-0 object-cover")} />;
  const icon = nodeIconClassNames(null);
  return (
    <div className={cn(icon.wrapper, box)}>
      <AppWindow
        className={cn(size === "sm" ? "h-4 w-4" : size === "lg" ? "h-6 w-6" : "h-5 w-5", icon.icon)}
      />
    </div>
  );
}
