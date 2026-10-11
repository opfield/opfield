import { Notice } from "@/components/common/Notice";
import type { AvailabilityDurability } from "@/types";
import { formatRtt, NEAR_RTT_MS } from "./availability-labels";

/**
 * What the chosen durability means for these servers: how far apart they are (near ≤ 10 ms
 * round trip defaults to synchronous, far to asynchronous), what a synchronous commit costs,
 * and what an unplanned failover can lose (the backend's loss-window sentence).
 */
export function DurabilityNotice({
  durability,
  rttP50Ms,
  lossWindowText,
  defaultDurability,
  unit = "commit",
}: {
  durability: AvailabilityDurability;
  rttP50Ms: number | null;
  lossWindowText: string;
  defaultDurability?: AvailabilityDurability;
  /** What waits for the copy: a database commit or a storage write. */
  unit?: "commit" | "write";
}) {
  const far = rttP50Ms !== null && rttP50Ms > NEAR_RTT_MS;
  const slowCommits = durability === "synchronous" && far;
  const distance =
    rttP50Ms === null
      ? "Round trip not measured yet"
      : `${far ? "Far" : "Near"} servers · ${formatRtt(rttP50Ms)} round trip`;
  return (
    <Notice tone={slowCommits ? "warning" : "info"} title={distance}>
      <p>{lossWindowText}</p>
      <p className="mt-1 text-xs">
        {durability === "synchronous"
          ? rttP50Ms === null
            ? `Each ${unit} waits until the copy confirms it.`
            : `Each ${unit} waits until the copy confirms it: about ${formatRtt(rttP50Ms)} more per ${unit}.`
          : `${unit === "commit" ? "Commits" : "Writes"} do not wait for the copy.`}{" "}
        {!defaultDurability
          ? null
          : defaultDurability !== durability
            ? `${far ? "Far" : "Near"} servers default to ${defaultDurability}.`
            : `Servers within ${NEAR_RTT_MS} ms default to synchronous, farther ones to asynchronous.`}
      </p>
    </Notice>
  );
}
