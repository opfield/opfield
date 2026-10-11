// Frontend UI rules, checked statically over every non-test src/**/*.tsx.
// Each rule receives one parsed file and reports violations through `report(node, message)`.
import ts from "typescript";

const RETIRED_COMPONENTS = new Map([
  ["ToggleField", "SwitchCard or CheckboxCard"],
  ["InlineFolderEditor", "FolderRenameDialog"],
  ["OneTimeTokenDialog", "OneTimeSecretDialog"],
]);

const SPLIT_FOOTER_CLASS_RE =
  /(?:^|\s)(?:[^\s:]+:)*(?:justify-(?:between|around|evenly|start)|mr-auto|ml-auto)(?=\s|$)/;
const FOOTER_SPACER_CLASS_RE = /^\s*(?:flex-1|grow)\s*$/;
// Same pattern as the runtime guard in components/ui/dialog.tsx.
const NESTED_VERTICAL_SCROLL_CLASS_RE = /(?:^|\s)(?:[^\s:]+:)*overflow-y-(?:auto|scroll)(?=\s|$)/;
const DATE_LOCALE_METHODS = new Set(["toLocaleDateString", "toLocaleTimeString"]);
const STANDARD_BUTTON_SIZES = new Set(["default", "icon", "inline"]);
const SIZE_EXCEPTION_RE = /size-exception:\s*\S/;

export function tagName(opening) {
  return opening.tagName.getText();
}

function openingOf(node) {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return undefined;
}

function attribute(opening, name) {
  return opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === name
  );
}

/** Raw text of an attribute initializer, or "" when absent. */
function attributeText(opening, name) {
  return attribute(opening, name)?.initializer?.getText() ?? "";
}

/** Every string literal inside a className attribute (conditionals and cn() calls included). */
function classNameStrings(opening) {
  const initializer = attribute(opening, "className")?.initializer;
  if (!initializer) return [];
  const texts = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) texts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  return texts;
}

/** The size values an attribute can take: string results of literals, conditionals and fallbacks. */
function sizeValues(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) {
    return node.expression ? sizeValues(node.expression) : [];
  }
  if (ts.isConditionalExpression(node)) {
    return [...sizeValues(node.whenTrue), ...sizeValues(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return sizeValues(node.right);
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [...sizeValues(node.left), ...sizeValues(node.right)];
    }
  }
  return [];
}

/** Whether the source line above the node's first line carries a `size-exception:` comment. */
function hasSizeException(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  if (line === 0) return false;
  const above = source.text.split("\n")[line - 1] ?? "";
  return SIZE_EXCEPTION_RE.test(above);
}

function meaningfulChildren(element) {
  return element.children.filter((child) => !ts.isJsxText(child) || child.getText().trim() !== "");
}

function isNamed(node, name) {
  const opening = openingOf(node);
  return opening !== undefined && tagName(opening) === name;
}

function isRenderable(child) {
  if (ts.isJsxText(child)) return child.getText().trim().length > 0;
  if (ts.isJsxExpression(child)) return child.expression !== undefined;
  if (ts.isJsxFragment(child)) return child.children.some(isRenderable);
  return true;
}

function contains(node, predicate) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (predicate(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

const iconImportsByFile = new WeakMap();

/** Names a file imports from an icon package (lucide-react). */
function iconImports(file) {
  let names = iconImportsByFile.get(file);
  if (names) return names;
  names = new Set();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!/^lucide-react/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.add(element.name.text);
    }
  }
  iconImportsByFile.set(file, names);
  return names;
}

/** An icon element: an svg, an icon-package import, or a component named *Icon / *.icon. */
function isIconTag(name, file) {
  return name === "svg" || iconImports(file).has(name) || /(?:Icon|\.icon)$/.test(name);
}

export const RULES = [
  {
    id: "form-label-spacing",
    source: "formerly src/test/form-field-spacing.test.ts",
    description: "A label stacked above its control sits in a space-y-1.5 wrapper.",
    visit(node, report) {
      if (!ts.isJsxElement(node) || tagName(node.openingElement) !== "label") return;
      const own = attributeText(node.openingElement, "className");
      if (own.includes("flex") && !own.includes("flex-col")) return;
      if (own.includes("space-y-")) {
        if (!own.includes("space-y-1.5")) report(node, `label spacing ${own} is not space-y-1.5`);
        return;
      }
      const parent = node.parent;
      if (!ts.isJsxElement(parent) || tagName(parent.openingElement) !== "div") return;
      const parentClass = attributeText(parent.openingElement, "className");
      if (parentClass.includes("flex") && !parentClass.includes("flex-col")) return;
      const children = meaningfulChildren(parent);
      if (children[0] !== node || children.length < 2) return;
      if (!parentClass.includes("space-y-1.5")) {
        report(node, `label and control wrapper ${parentClass || "has no class"}; use space-y-1.5`);
      }
    },
  },
  {
    id: "dialog-payload-retention",
    source: "formerly src/components/ui/dialog-payload-retention.structure.test.ts",
    description:
      "A Dialog that clears the state it renders on close keeps it through the exit animation with useRetainedDialogValue.",
    visit(node, report, file) {
      if (!ts.isJsxElement(node) || tagName(node.openingElement) !== "Dialog") return;
      const handler = attributeText(node.openingElement, "onOpenChange");
      const body = node.getText();
      for (const match of handler.matchAll(/set([A-Z][A-Za-z0-9_]*)\((?:null|undefined)\)/g)) {
        const suffix = match[1];
        const state = suffix[0].toLowerCase() + suffix.slice(1);
        const retained = new RegExp(`useRetainedDialogValue\\(\\s*${state}\\s*,`);
        if (body.includes(state) && !retained.test(file.text)) {
          report(node, `clears ${state} on close without useRetainedDialogValue(${state}, …)`);
        }
      }
    },
  },
  {
    id: "dialog-footer-right",
    source: "formerly src/components/ui/dialog.test.ts; design corrections #31",
    description: "Every DialogFooter keeps all of its buttons together on the right.",
    visit(node, report) {
      if (!ts.isJsxElement(node) || tagName(node.openingElement) !== "DialogFooter") return;
      const visit = (current) => {
        const opening = openingOf(current);
        if (opening) {
          const texts = classNameStrings(opening);
          if (
            texts.some((text) => SPLIT_FOOTER_CLASS_RE.test(text)) ||
            (ts.isJsxSelfClosingElement(current) &&
              texts.some((text) => FOOTER_SPACER_CLASS_RE.test(text)))
          ) {
            report(current, "splits the footer; keep every button in one right-aligned group");
          }
        }
        ts.forEachChild(current, visit);
      };
      visit(node);
    },
  },
  {
    id: "dialog-description-in-body",
    source: "formerly src/components/ui/dialog.test.ts; ConfirmDialog body description convention",
    description:
      "A DialogHeader subtitle is not the dialog's body: a DialogContent with a DialogDescription in its header also renders a body.",
    visit(node, report) {
      if (!ts.isJsxElement(node) || tagName(node.openingElement) !== "DialogContent") return;
      const children = meaningfulChildren(node);
      const header = children.find((child) => isNamed(child, "DialogHeader"));
      if (!header || !ts.isJsxElement(header)) return;
      if (!contains(header, (current) => isNamed(current, "DialogDescription"))) return;
      const body = children.filter(
        (child) => !isNamed(child, "DialogHeader") && !isNamed(child, "DialogFooter")
      );
      if (!body.some(isRenderable)) {
        report(node, "puts the dialog's text in the header subtitle; move it into the body");
      }
    },
  },
  {
    id: "dialog-single-scroll",
    source: "runtime guard in src/components/ui/dialog.tsx",
    description: "DialogContent owns vertical scrolling; its body children do not scroll on their own.",
    visit(node, report) {
      if (!ts.isJsxElement(node) || tagName(node.openingElement) !== "DialogContent") return;
      for (const child of meaningfulChildren(node)) {
        const opening = openingOf(child);
        if (!opening || ["DialogHeader", "DialogFooter"].includes(tagName(opening))) continue;
        if (classNameStrings(opening).some((text) => NESTED_VERTICAL_SCROLL_CLASS_RE.test(text))) {
          report(child, "adds a second vertical scroll inside DialogContent");
        }
      }
    },
  },
  {
    id: "button-standard-size",
    source: "owner rule 2026-10: every console button is 36 px tall",
    description:
      'Buttons are 36 px: size default, "icon" or "inline" (text links). Any other size needs a `// size-exception: <reason>` comment on the line above.',
    visit(node, report, source) {
      const opening = openingOf(node);
      if (!opening || tagName(opening) !== "Button") return;
      const size = attribute(opening, "size");
      const initializer = size?.initializer;
      if (!initializer) return;
      const values = sizeValues(initializer);
      const other = values.filter((value) => !STANDARD_BUTTON_SIZES.has(value));
      if (other.length === 0) return;
      if (hasSizeException(source, size) || hasSizeException(source, opening)) return;
      report(
        size,
        `uses size ${other.map((value) => `"${value}"`).join(", ")}; buttons are 36 px (default, "icon" or "inline") unless the line above says // size-exception: <reason>`
      );
    },
  },
  {
    id: "retired-component",
    source: "design corrections #32, #37, #40",
    description: "Retired one-off components stay gone; the shared replacement is used.",
    visit(node, report) {
      let name;
      if (ts.isImportSpecifier(node)) name = node.name.text;
      else {
        const opening = openingOf(node);
        if (opening) name = tagName(opening);
      }
      if (name && RETIRED_COMPONENTS.has(name)) {
        report(node, `${name} was retired; use ${RETIRED_COMPONENTS.get(name)}`);
      }
    },
  },
  {
    id: "shared-date-format",
    source: "design corrections #19 (one date language)",
    description:
      "Dates render through RelativeTime / formatRelativeDate / formatDate / formatDateTime, not ad-hoc toLocale* calls.",
    visit(node, report) {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const dateReceiver =
        ts.isNewExpression(receiver) && receiver.expression.getText() === "Date";
      if (DATE_LOCALE_METHODS.has(method) || (method === "toLocaleString" && dateReceiver)) {
        report(node, `formats a date with ${method}(); use the shared date helpers`);
      }
    },
  },
  {
    id: "tab-trigger-text-only",
    source: "owner request 2026-10-11 (2.12: tab bars without icons)",
    description: "Tab bar items (TabsTrigger) are text only; they render no icon.",
    visit(node, report, file) {
      if (!ts.isJsxElement(node) || tagName(node.openingElement) !== "TabsTrigger") return;
      const visit = (current) => {
        const opening = openingOf(current);
        if (opening && current !== node && isIconTag(tagName(opening), file)) {
          report(current, `renders the icon ${tagName(opening)} in a tab; tabs are text only`);
        }
        ts.forEachChild(current, visit);
      };
      for (const child of node.children) visit(child);
    },
  },
];
