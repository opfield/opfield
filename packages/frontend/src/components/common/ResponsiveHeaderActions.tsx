import { EllipsisVertical } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRegisterCommandPalettePageActions } from "@/hooks/use-command-palette-page-actions";

export interface ResponsiveHeaderAction {
  id?: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
  alwaysOverflow?: boolean;
  priority?: number;
  separatorBefore?: boolean;
}

export const HEADER_ACTION_PRIORITY = {
  default: 0,
  primary: 100,
  emergency: 1_000,
} as const;

export function shouldForceHeaderActionOverflow(action: ResponsiveHeaderAction): boolean {
  return Boolean(action.alwaysOverflow || action.destructive);
}

const MIN_HEADER_CONTENT_WIDTH_PX = 320;
const HEADER_ACTION_GAP_PX = 8;
/** Direct header actions shown at most; the rest go to the overflow menu. */
const MAX_DIRECT_HEADER_ACTIONS = 6;

interface MeasuredHeaderAction {
  width: number;
  priority?: number;
  alwaysOverflow?: boolean;
}

export function getHeaderActionOverflowIndices(
  headerWidth: number,
  actions: MeasuredHeaderAction[],
  overflowWidth: number,
  reservedContentWidth = MIN_HEADER_CONTENT_WIDTH_PX,
  gapWidth = HEADER_ACTION_GAP_PX
): number[] {
  const overflowIndices = new Set(
    actions.flatMap((action, index) => (action.alwaysOverflow ? [index] : []))
  );
  const collapseOrder = actions
    .map((action, index) => ({ index, priority: action.priority ?? 0 }))
    .filter(({ index }) => !overflowIndices.has(index))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  // The cap holds before layout can be measured, so a header never starts wider than it.
  for (const action of collapseOrder) {
    if (actions.length - overflowIndices.size <= MAX_DIRECT_HEADER_ACTIONS) break;
    overflowIndices.add(action.index);
  }

  if (
    headerWidth <= 0 ||
    overflowWidth <= 0 ||
    actions.length === 0 ||
    actions.some((action) => action.width <= 0)
  ) {
    return [...overflowIndices].sort((a, b) => a - b);
  }

  // Header identity is primary: actions may use at most half of the row and
  // must overflow before the title/status area is forced to truncate.
  const availableWidth = Math.min(headerWidth - reservedContentWidth, headerWidth / 2);
  const requiredWidth = () => {
    const visibleWidth = actions.reduce(
      (total, action, index) => total + (overflowIndices.has(index) ? 0 : action.width),
      0
    );
    const visibleCount = actions.length - overflowIndices.size;
    const renderedItemCount = visibleCount + (overflowIndices.size > 0 ? 1 : 0);
    return (
      visibleWidth +
      (overflowIndices.size > 0 ? overflowWidth : 0) +
      Math.max(0, renderedItemCount - 1) * gapWidth
    );
  };

  for (const action of collapseOrder) {
    if (overflowIndices.has(action.index)) continue;
    if (requiredWidth() <= availableWidth) break;
    overflowIndices.add(action.index);
  }

  return [...overflowIndices].sort((a, b) => a - b);
}

export function getHeaderActionOverflowCount(
  headerWidth: number,
  actionWidths: number[],
  overflowWidth: number,
  reservedContentWidth = MIN_HEADER_CONTENT_WIDTH_PX,
  gapWidth = HEADER_ACTION_GAP_PX
): number {
  return getHeaderActionOverflowIndices(
    headerWidth,
    actionWidths.map((width) => ({ width })),
    overflowWidth,
    reservedContentWidth,
    gapWidth
  ).length;
}

export function shouldCollapseHeaderActions(
  headerWidth: number,
  actionsWidth: number,
  reservedContentWidth = MIN_HEADER_CONTENT_WIDTH_PX
): boolean {
  return headerWidth > 0 && actionsWidth > 0 && headerWidth < actionsWidth + reservedContentWidth;
}

export function HeaderOverflowMenu({
  actions,
  disabled = false,
  ariaLabel = "More page actions",
  menuClassName,
}: {
  actions: ResponsiveHeaderAction[];
  disabled?: boolean;
  ariaLabel?: string;
  menuClassName?: string;
}) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          disabled={disabled}
          aria-label={ariaLabel}
          title={ariaLabel}
        >
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={menuClassName}>
        {actions.map((action, index) => (
          <ResponsiveHeaderActionItem
            key={action.id ?? `${action.label}:${index}`}
            action={action}
            showSeparator={index > 0 && action.separatorBefore}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ResponsiveHeaderActions({
  children,
  actions,
  className = "",
  reservedContentWidth = MIN_HEADER_CONTENT_WIDTH_PX,
  menuClassName,
}: {
  children: ReactNode;
  actions: ResponsiveHeaderAction[];
  className?: string;
  reservedContentWidth?: number;
  menuClassName?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const actionMetadataRef = useRef<
    Array<Pick<ResponsiveHeaderAction, "alwaysOverflow" | "destructive" | "priority">>
  >([]);
  const overflowMeasureRef = useRef<HTMLDivElement>(null);
  const [responsiveOverflowIndices, setResponsiveOverflowIndices] = useState<number[]>([]);
  const actionChildren = useMemo(() => flattenActionChildren(children), [children]);
  const actionSignature = actions
    .map(
      (action) =>
        `${action.id ?? ""}:${action.label}:${action.destructive ? 1 : 0}:${action.alwaysOverflow ? 1 : 0}:${action.priority ?? 0}`
    )
    .join("|");
  actionMetadataRef.current = actions.map(({ alwaysOverflow, destructive, priority }) => ({
    alwaysOverflow,
    destructive,
    priority,
  }));
  const forcedOverflowIndices = actions.flatMap((action, index) =>
    shouldForceHeaderActionOverflow(action) ? [index] : []
  );
  const renderedActionCount = Math.min(actions.length, actionChildren.length);
  const effectiveOverflowIndices = new Set(
    [...responsiveOverflowIndices, ...forcedOverflowIndices].filter(
      (index) => index < renderedActionCount
    )
  );
  const overflowActions = actions.filter((_, index) => effectiveOverflowIndices.has(index));

  useRegisterCommandPalettePageActions(
    actions.map((action, index) => ({
      id:
        action.id ??
        `header:${action.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "action"}:${index}`,
      label: action.label,
      icon: action.icon,
      action: action.onClick,
      disabled: action.disabled,
    }))
  );

  useLayoutEffect(() => {
    if (!actionSignature) return;

    const root = rootRef.current;
    const header = root?.parentElement;
    if (!root || !header) return;

    const updateLayout = () => {
      const actionWidths = Array.from(
        actionsRef.current?.querySelectorAll<HTMLElement>("[data-header-action-item]") ?? []
      ).map((element) => element.getBoundingClientRect().width);
      const overflowWidth = overflowMeasureRef.current?.getBoundingClientRect().width ?? 0;
      const measuredGap = Number.parseFloat(
        actionsRef.current ? window.getComputedStyle(actionsRef.current).columnGap : ""
      );
      const nextOverflowIndices = getHeaderActionOverflowIndices(
        header.getBoundingClientRect().width,
        actionWidths.map((width, index) => ({
          width,
          priority: actionMetadataRef.current[index]?.priority,
          alwaysOverflow:
            actionMetadataRef.current[index]?.destructive ||
            actionMetadataRef.current[index]?.alwaysOverflow,
        })),
        overflowWidth,
        reservedContentWidth,
        Number.isFinite(measuredGap) ? measuredGap : HEADER_ACTION_GAP_PX
      );
      setResponsiveOverflowIndices((current) =>
        current.length === nextOverflowIndices.length &&
        current.every((index, position) => index === nextOverflowIndices[position])
          ? current
          : nextOverflowIndices
      );
    };

    updateLayout();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateLayout);
    observer.observe(header);
    if (overflowMeasureRef.current) observer.observe(overflowMeasureRef.current);
    for (const element of actionsRef.current?.children ?? []) observer.observe(element);
    return () => observer.disconnect();
  }, [actionSignature, reservedContentWidth]);

  if (actions.length === 0) return null;

  return (
    <div ref={rootRef} className="ml-auto flex shrink-0 self-center">
      <div ref={actionsRef} className={`flex items-center gap-2 ${className}`}>
        {actionChildren.map((child, index) => {
          const isOverflowed = effectiveOverflowIndices.has(index);
          return (
            <div
              key={actions[index]?.id ?? actions[index]?.label ?? index}
              data-header-action-item=""
              aria-hidden={isOverflowed || undefined}
              className={
                isOverflowed
                  ? "pointer-events-none fixed -left-full top-0 invisible w-max"
                  : "shrink-0"
              }
            >
              {child}
            </div>
          );
        })}
        {effectiveOverflowIndices.size > 0 ? (
          <HeaderOverflowMenu
            actions={overflowActions}
            ariaLabel="Page actions"
            menuClassName={menuClassName}
          />
        ) : null}
      </div>
      <div
        ref={overflowMeasureRef}
        data-header-overflow-measure=""
        aria-hidden="true"
        className="pointer-events-none fixed -left-full top-0 invisible w-max"
      >
        <Button variant="outline" size="icon" tabIndex={-1} aria-label="Page actions">
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function flattenActionChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return flattenActionChildren(child.props.children);
    }
    return [child];
  });
}

function ResponsiveHeaderActionItem({
  action,
  showSeparator = action.separatorBefore,
}: {
  action: ResponsiveHeaderAction;
  showSeparator?: boolean;
}) {
  return (
    <>
      {showSeparator ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        disabled={action.disabled}
        title={action.disabled ? action.disabledReason : undefined}
        onClick={action.onClick}
        className={action.destructive ? "text-destructive" : undefined}
      >
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </>
  );
}
