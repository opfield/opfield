import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive-solid text-destructive-foreground hover:bg-destructive-solid/90",
        warning: "bg-warning text-on-warning hover:bg-warning/90",
        outline: "border border-border bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-[color:var(--color-link)] underline-offset-4 hover:underline",
        // Text-only action inside a sentence, footer or caption.
        quiet: "text-muted-foreground hover:text-foreground",
      },
      size: {
        default: "h-9 rounded-full px-4 py-2",
        // Every size keeps the same text size; smaller buttons are only lower.
        sm: "h-8 rounded-full px-3",
        lg: "h-10 rounded-full px-8",
        icon: "h-9 w-9 shrink-0 aspect-square rounded-md",
        "icon-lg": "h-10 w-10 shrink-0 aspect-square rounded-md",
        "icon-sm": "h-8 w-8 shrink-0 aspect-square rounded-md",
        "icon-xs": "h-7 w-7 shrink-0 aspect-square rounded-md",
        // No box of its own: sits in running text at the surrounding font size.
        inline: "h-auto gap-1 p-0 text-[length:inherit]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * The action this button started is running: the button is disabled and
   * shows a spinner, so a second click cannot start it again.
   */
  pending?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, pending = false, disabled, children, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        data-button=""
        className={cn(
          buttonVariants({ variant, size, className }),
          // The spinner takes the place of a leading icon, so the width holds.
          pending && "[&>[data-pending-spinner]+svg]:hidden"
        )}
        ref={ref}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {pending ? (
              <Loader2 data-pending-spinner="" className="animate-spin" aria-hidden="true" />
            ) : null}
            {children}
          </>
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
