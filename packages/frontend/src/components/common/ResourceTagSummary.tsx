import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  estimateMoreTagsWidth,
  estimateResourceTagWidth,
  parseResourceTag,
  resourceTagBadgeProps,
} from "@/lib/resource-tags";
import { cn } from "@/lib/utils";

const GAP_WIDTH = 8;

/**
 * A row's tags next to its type badge, sized to the tags column: the tags that fit are shown and
 * the rest collapse into a "+N" badge with the full list on hover. When no tag fits, all of them
 * collapse.
 */
export function ResourceTagSummary({
  tags,
  typeBadge,
  typeFirst = false,
}: {
  tags: string[];
  typeBadge: React.ReactNode;
  /** Puts the type badge before the tags instead of after them. */
  typeFirst?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const typeRef = useRef<HTMLSpanElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [typeWidth, setTypeWidth] = useState<number | null>(null);
  const parsedTags = useMemo(() => tags.map(parseResourceTag), [tags]);
  const visibleCount = useMemo(() => {
    if (parsedTags.length <= 2 && containerWidth === null) return parsedTags.length;
    if (containerWidth === null || containerWidth <= 0) return Math.min(2, parsedTags.length);

    const availableWidth = Math.max(0, containerWidth - (typeWidth ?? 0) - GAP_WIDTH);
    let usedWidth = 0;
    let count = 0;

    for (let index = 0; index < parsedTags.length; index += 1) {
      const remaining = parsedTags.length - index - 1;
      const tagWidth = estimateResourceTagWidth(parsedTags[index]!);
      const moreWidth = remaining > 0 ? estimateMoreTagsWidth(remaining) + GAP_WIDTH : 0;
      const nextWidth = usedWidth + (count > 0 ? GAP_WIDTH : 0) + tagWidth;
      if (nextWidth + moreWidth > availableWidth) break;
      usedWidth = nextWidth;
      count += 1;
    }

    return count;
  }, [containerWidth, parsedTags, typeWidth]);

  useEffect(() => {
    const container = containerRef.current;
    const typeElement = typeRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(container.getBoundingClientRect().width);
      if (typeElement) setTypeWidth(typeElement.getBoundingClientRect().width);
    });
    observer.observe(container);
    if (typeElement) observer.observe(typeElement);
    return () => observer.disconnect();
  }, []);

  const visibleTags = parsedTags.slice(0, visibleCount);
  const hiddenTags = parsedTags.slice(visibleCount);
  const type = (
    <span ref={typeRef} className="inline-flex shrink-0">
      {typeBadge}
    </span>
  );

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center justify-end gap-2">
      {typeFirst && type}
      {visibleTags.map((tag, index) => {
        const badge = resourceTagBadgeProps(tag.color);
        return (
          <Badge
            key={`${tag.raw}:${index}`}
            variant={badge.variant}
            className={cn("max-w-[180px]", badge.className)}
            title={tag.raw}
          >
            {tag.label}
          </Badge>
        );
      })}
      {hiddenTags.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="shrink-0">
              +{hiddenTags.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="flex flex-wrap gap-1.5">
              {hiddenTags.map((tag, index) => {
                const badge = resourceTagBadgeProps(tag.color);
                return (
                  <Badge
                    key={`${tag.raw}:${visibleCount + index}`}
                    variant={badge.variant}
                    className={cn("max-w-[180px]", badge.className)}
                  >
                    {tag.label}
                  </Badge>
                );
              })}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
      {!typeFirst && type}
    </div>
  );
}
