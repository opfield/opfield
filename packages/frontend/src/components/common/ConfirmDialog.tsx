import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmState {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  cancelVariant: "outline" | "ghost";
  variant: "default" | "destructive";
  locked: boolean;
  pending: boolean;
  onConfirm: (() => void | Promise<void>) | null;
  show: (opts: {
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    cancelVariant?: "outline" | "ghost";
    variant?: "default" | "destructive";
    locked?: boolean;
    onConfirm: () => void | Promise<void>;
  }) => void;
  setPending: (pending: boolean) => void;
  close: () => void;
}

export const useConfirmDialog = create<ConfirmState>()((set) => ({
  open: false,
  title: "",
  description: "",
  confirmLabel: "Confirm",
  cancelLabel: "Cancel",
  cancelVariant: "outline",
  variant: "default",
  locked: false,
  pending: false,
  onConfirm: null,
  show: ({
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    cancelVariant = "outline",
    variant = "destructive",
    locked = false,
    onConfirm,
  }) =>
    set({
      open: true,
      title,
      description,
      confirmLabel,
      cancelLabel,
      cancelVariant,
      variant,
      locked,
      pending: false,
      onConfirm,
    }),
  setPending: (pending) => set({ pending }),
  close: () => set({ open: false, pending: false, onConfirm: null }),
}));

export function confirm(opts: {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  cancelVariant?: "outline" | "ghost";
  variant?: "default" | "destructive";
  locked?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmDialog.getState().show({
      ...opts,
      onConfirm: () => {
        resolve(true);
        useConfirmDialog.getState().close();
      },
    });
    const unsub = useConfirmDialog.subscribe((state) => {
      if (!state.open) {
        resolve(false);
        unsub();
      }
    });
  });
}

export function confirmAction(
  opts: {
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    cancelVariant?: "outline" | "ghost";
    variant?: "default" | "destructive";
  },
  action: () => Promise<boolean> | Promise<void>
): Promise<boolean> {
  return new Promise((resolve) => {
    let completed = false;
    useConfirmDialog.getState().show({
      ...opts,
      onConfirm: async () => {
        if (useConfirmDialog.getState().pending) return;
        useConfirmDialog.getState().setPending(true);
        try {
          const result = await action();
          if (result === false) {
            useConfirmDialog.getState().setPending(false);
            return;
          }
          completed = true;
          resolve(true);
          useConfirmDialog.getState().close();
        } catch {
          useConfirmDialog.getState().setPending(false);
        }
      },
    });
    const unsub = useConfirmDialog.subscribe((state) => {
      if (!state.open) {
        if (!completed) resolve(false);
        unsub();
      }
    });
  });
}

export function ConfirmDialog() {
  const {
    open,
    title,
    description,
    confirmLabel,
    cancelLabel,
    cancelVariant,
    variant,
    locked,
    pending,
    onConfirm,
    close,
  } = useConfirmDialog();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !locked && !pending && close()}>
      <DialogContent
        hideCloseButton={locked || pending}
        className="max-w-[calc(100vw-2rem)] sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (locked || pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (locked || pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (locked || pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="break-words [overflow-wrap:anywhere]">
          {description}
        </DialogDescription>
        <DialogFooter>
          <Button variant={cancelVariant} onClick={close} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            pending={pending}
            onClick={() => {
              void onConfirm?.();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
