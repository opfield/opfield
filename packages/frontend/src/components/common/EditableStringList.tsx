import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function EditableStringList({
  values,
  onChange,
  placeholder,
  itemLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  itemLabel: string;
}) {
  const rows = values.length > 0 ? values : [""];

  const update = (index: number, value: string) => {
    const next = [...rows];
    next[index] = value;
    onChange(next);
  };

  const add = () => onChange([...rows, ""]);
  const remove = (index: number) => onChange(rows.filter((_, rowIndex) => rowIndex !== index));

  return (
    <div className="w-full border border-input bg-background">
      <AnimatePresence initial={false} mode="popLayout">
        {rows.map((value, index) => (
          <motion.div
            key={`editable-string-${index}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{
              opacity: { duration: 0.12 },
              y: { duration: 0.12, ease: [0.25, 0.1, 0.25, 1] },
            }}
            className="flex min-w-0 border-b border-border last:border-b-0"
          >
            <Input
              value={value}
              onChange={(event) => update(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && index === rows.length - 1 && value.trim()) {
                  event.preventDefault();
                  add();
                }
              }}
              aria-label={`${itemLabel} ${index + 1}`}
              placeholder={placeholder}
              className="h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            />
            {rows.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`}
                className="border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => remove(index)}
              >
                <Minus className="h-4 w-4" />
              </Button>
            ) : null}
            {index === rows.length - 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Add ${itemLabel.toLowerCase()}`}
                className="border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={add}
              >
                <Plus className="h-4 w-4" />
              </Button>
            ) : null}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
