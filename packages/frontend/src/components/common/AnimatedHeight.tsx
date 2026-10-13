import { motion } from "framer-motion";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function AnimatedHeight({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");

  useLayoutEffect(() => {
    if (containerRef.current) setHeight(containerRef.current.getBoundingClientRect().height);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      animate={{ height: height === "auto" ? "auto" : height + 16 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      data-animated-height=""
      className="-mx-2 -my-2 overflow-hidden px-2 py-2"
    >
      <div ref={containerRef}>{children}</div>
    </motion.div>
  );
}
