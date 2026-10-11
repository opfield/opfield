/**
 * Class sets for the AI panel's raw controls.
 *
 * The composer toolbar, queued-message rows, message actions and tool-call
 * disclosures stay raw <button>s on purpose: they are dense, borderless
 * controls with a colour-only hover, which the kit Button (background hover,
 * fixed heights) does not reproduce. These sets keep them consistent with each
 * other and give every one of them the kit's keyboard focus ring.
 */

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Borderless icon control. The caller sets the size: h-9 w-9, the console's one button height. */
export const AI_ICON_CONTROL = `flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground ${FOCUS_RING}`;

/** Dimmed, inert state for controls that are disabled while they cannot act. */
export const AI_CONTROL_DISABLED = "disabled:pointer-events-none disabled:opacity-30";

/** Labelled menu trigger in the composer toolbar (mode, model, reasoning). Colour is set by the caller. */
export const AI_TOOLBAR_TRIGGER = `flex h-9 items-center gap-2 px-1.5 text-sm transition-colors ${FOCUS_RING}`;

/** Muted colour of a toolbar trigger that shows no special state. */
export const AI_TOOLBAR_TRIGGER_MUTED =
  "text-muted-foreground hover:text-foreground focus-visible:text-foreground";

/** Inline text action in a row (Send now, Retry). Colour is set by the caller. */
export const AI_TEXT_ACTION = `flex shrink-0 items-center gap-1 font-medium hover:underline ${FOCUS_RING}`;

/** Header of an expandable tool call or tool-call group in the message stream. */
export const AI_DISCLOSURE_HEADER =
  "group flex items-center gap-2 py-0.5 text-left text-muted-foreground transition-colors";

/** Interactive state of a disclosure header that can be toggled. */
export const AI_DISCLOSURE_HEADER_INTERACTIVE =
  "cursor-pointer hover:text-foreground focus-visible:text-foreground focus-visible:outline-none";

/** Image thumbnail that opens a preview (composer attachments, sent attachments). */
export const AI_ATTACHMENT_TILE = `h-16 w-16 overflow-hidden border border-border bg-muted transition-colors hover:border-foreground ${FOCUS_RING}`;
