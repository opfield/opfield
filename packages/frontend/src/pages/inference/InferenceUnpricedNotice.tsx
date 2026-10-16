import { BadgeDollarSign } from "lucide-react";
import { Notice, NoticeAction } from "@/components/common/Notice";

/** Shown wherever an API source has no price set (Settings → Inference, usage, activity). */
export const INFERENCE_PRICE_MISSING_WARNING =
  "No price set: requests are not charged to API budgets";

/**
 * Models whose recent requests ran on an API source with no price: tokens are recorded, the cost is unknown and
 * outside API budgets, until an administrator sets a price.
 */
export function InferenceUnpricedNotice({
  models,
  windowDays = 7,
  showAction = true,
}: {
  models: string[];
  windowDays?: number;
  showAction?: boolean;
}) {
  if (models.length === 0) return null;
  const list =
    models.length > 3
      ? `${models.slice(0, 3).join(", ")} and ${models.length - 3} more`
      : models.join(", ");
  return (
    <Notice
      tone="warning"
      icon={BadgeDollarSign}
      role="status"
      title={
        models.length === 1
          ? "An inference model has no price set"
          : `${models.length} inference models have no price set`
      }
      actions={
        showAction ? (
          <NoticeAction tone="warning" to="/settings/inference">
            Set prices
          </NoticeAction>
        ) : null
      }
    >
      <p>
        {list} served requests in the last {windowDays} days without an API price. Their tokens are
        recorded, but they are not charged to API budgets.
      </p>
    </Notice>
  );
}
