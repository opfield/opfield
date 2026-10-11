import { cn } from "@/lib/utils";

// The eight nodes of the Opfield mark (node ring) in a 48 × 48 box.
const NODES: ReadonlyArray<readonly [number, number]> = [
  [19.5, 4.5],
  [30.11, 8.89],
  [34.5, 19.5],
  [30.11, 30.11],
  [19.5, 34.5],
  [8.89, 30.11],
  [4.5, 19.5],
  [8.89, 8.89],
];

/**
 * The Opfield mark without a tile: drawn in the foreground colour, so it is black on the light
 * theme and white on the dark one. Size it with h-/w- classes like the icon it replaces.
 */
export function OpfieldMark({
  className,
  title = "Opfield",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
      className={cn("shrink-0 text-foreground", className)}
    >
      <g fill="currentColor">
        {NODES.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="9" height="9" rx="2.4" />
        ))}
      </g>
    </svg>
  );
}
