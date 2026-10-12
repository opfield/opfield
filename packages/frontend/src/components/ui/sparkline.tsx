interface SparklineProps {
  /** A null point is a gap: skipped, never drawn as 0. */
  data: Array<number | null>;
  width?: number;
  height?: number;
  color?: string;
  fillOpacity?: number;
  className?: string;
  /** Floor value for the Y axis. Defaults to 0 so low values don't hug the bottom. */
  minValue?: number;
  /** Ceiling value for the Y axis. Useful for metrics with a known max (e.g., total memory). */
  maxValue?: number;
}

export function Sparkline({
  data,
  width = 200,
  height = 32,
  color = "currentColor",
  fillOpacity = 0.1,
  className,
  minValue = 0,
  maxValue,
}: SparklineProps) {
  const known = data.flatMap((value, index) =>
    typeof value === "number" && Number.isFinite(value) ? [{ value, index }] : []
  );
  if (known.length === 0) return null;
  const last = Math.max(1, data.length - 1);
  // One known point draws a flat line across.
  const plotted =
    known.length === 1
      ? [
          { value: known[0]!.value, index: 0 },
          { value: known[0]!.value, index: last },
        ]
      : known;
  const values = plotted.map((point) => point.value);

  const min = Math.min(minValue, ...values);
  const max = maxValue != null ? Math.max(maxValue, ...values) : Math.max(...values);
  const range = max - min || 1;
  const stroke = 1.5;
  const top = stroke; // reserve space for stroke at peak

  const xOf = (index: number) => (index / last) * width;
  const points = plotted
    .map(({ value, index }) => {
      const y = top + (height - top) - ((value - min) / range) * (height - top);
      return `${xOf(index)},${y}`;
    })
    .join(" ");

  const fillPoints = `${xOf(plotted[0]!.index)},${height} ${points} ${xOf(plotted.at(-1)!.index)},${height}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ display: "block", height }}
    >
      <polyline points={fillPoints} fill={color} fillOpacity={fillOpacity} stroke="none" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
