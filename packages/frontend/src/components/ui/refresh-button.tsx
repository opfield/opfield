import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";

export function RefreshButton({
  onClick,
  disabled,
  minDurationMs = 3000,
}: {
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  minDurationMs?: number;
}) {
  const [spinning, setSpinning] = useState(false);

  const handleClick = async () => {
    if (spinning || disabled) return;
    setSpinning(true);
    const minDelay = new Promise((r) => setTimeout(r, minDurationMs));
    try {
      await Promise.all([onClick(), minDelay]);
    } finally {
      setSpinning(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Refresh"
      title="Refresh"
      onClick={handleClick}
      disabled={spinning || disabled}
    >
      <RefreshCw
        className="h-4 w-4"
        style={
          spinning
            ? {
                animation: `refresh-spin ${minDurationMs}ms linear infinite`,
              }
            : undefined
        }
      />
      <style>{`
        @keyframes refresh-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(720deg); }
        }
      `}</style>
    </Button>
  );
}
