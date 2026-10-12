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

// --- dialog close retention (a closing dialog keeps its content for the exit animation) ---
const CLOSE_OK_RE = /close-reset-ok:\s*\S/;
const OVERLAY_TAG_RE = /^(?:Dialog|AlertDialog|Sheet|Drawer|CommandDialog|[A-Z]\w*(?:Dialog|Sheet|Drawer|Wizard))$/;
const OPEN_NAME_RE = /^(?:open|isOpen|\w*Open)$/;
const RESET_CALL_RE = /^(?:set[A-Z]\w*|reset\w*|clear\w*)$/;

function hasCloseOk(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.text.split("\n");
  for (let index = line - 1; index >= Math.max(0, line - 3); index -= 1) {
    if (CLOSE_OK_RE.test(lines[index] ?? "")) return true;
  }
  return false;
}

function unwrap(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))) {
    current = current.expression;
  }
  return current;
}

/** Name tested by `!name` / `name === false`, or undefined. */
function negatedName(condition) {
  const expression = unwrap(condition);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = unwrap(expression.operand);
    if (ts.isIdentifier(operand)) return operand.text;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    expression.right.kind === ts.SyntaxKind.FalseKeyword &&
    ts.isIdentifier(expression.left)
  ) {
    return expression.left.text;
  }
  return undefined;
}

/** Reset-like calls (setX(...), resetX(), form.reset()) inside a statement. */
function resetCalls(node) {
  const calls = [];
  const visit = (current) => {
    if (ts.isFunctionLike(current) && current !== node) return;
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isIdentifier(callee) && RESET_CALL_RE.test(callee.text)) calls.push(callee.text);
      if (ts.isPropertyAccessExpression(callee) && /^reset/.test(callee.name.text)) {
        calls.push(callee.getText());
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

/** setFoo -> foo */
function stateOfSetter(setter) {
  return setter.startsWith("set") ? setter.charAt(3).toLowerCase() + setter.slice(4) : undefined;
}

function identifiersIn(node) {
  const names = new Set();
  const visit = (current) => {
    if (ts.isIdentifier(current)) names.add(current.text);
    ts.forEachChild(current, visit);
  };
  if (node) visit(node);
  return names;
}

/** The payload an `open` expression tests: `x !== null`, `!!x`, `Boolean(x)`, `x != null`, `x !== undefined`. */
function openPayload(expression) {
  const node = unwrap(expression);
  if (!node) return undefined;
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    const nullish =
      node.right.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(node.right) && node.right.text === "undefined");
    if (
      nullish &&
      (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken)
    ) {
      return unwrap(node.left).getText();
    }
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = unwrap(node.operand);
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
      return unwrap(inner.operand).getText();
    }
  }
  if (ts.isCallExpression(node) && node.expression.getText() === "Boolean" && node.arguments.length === 1) {
    return unwrap(node.arguments[0]).getText();
  }
  return undefined;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  {
    id: "dialog-close-keeps-content",
    source: "owner request 2026-10-12 (dialogs jump while closing)",
    description:
      "A closing dialog keeps its content for the exit animation: no state resets when open turns false (reset on open or after useDialogPresence ends), no payload read straight from state the close clears (useRetainedDialogValue), no `{x && <Dialog>}` mounts. Exceptions need `// close-reset-ok: <reason>` above.",
    visit(node, report, source) {
      // 1. onOpenChange={(open) => { if (!open) resetSomething() }} on an overlay.
      if (ts.isJsxAttribute(node) && node.name.getText() === "onOpenChange") {
        const opening = node.parent.parent;
        const handler = unwrap(node.initializer?.expression);
        if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) return;
        const parameter = handler.parameters[0]?.name;
        if (!parameter || !ts.isIdentifier(parameter)) return;
        const openNames = identifiersIn(attribute(opening, "open")?.initializer);
        const visit = (current) => {
          const guarded =
            (ts.isIfStatement(current) && negatedName(current.expression) === parameter.text
              ? current.thenStatement
              : undefined) ??
            (ts.isBinaryExpression(current) &&
            current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
            negatedName(current.left) === parameter.text
              ? current.right
              : undefined);
          if (guarded) {
            const offending = resetCalls(guarded).filter((call) => {
              const state = stateOfSetter(call);
              return !(state && openNames.has(state));
            });
            if (offending.length > 0 && !hasCloseOk(source, current)) {
              report(
                current,
                `resets ${offending.join(", ")} while the dialog is closing; reset on open or after useDialogPresence ends`
              );
            }
          }
          ts.forEachChild(current, visit);
        };
        visit(handler.body);
        return;
      }
      // 1b. A named open-change handler: function handleOpenChange(next) { if (!next) reset() }.
      const handlerName =
        (ts.isFunctionDeclaration(node) && node.name?.text) ||
        ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
          ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name) &&
          node.parent.name.text);
      if (handlerName && /OpenChange$/.test(handlerName)) {
        const parameter = node.parameters[0]?.name;
        if (!parameter || !ts.isIdentifier(parameter) || !node.body) return;
        const visit = (current) => {
          if (ts.isFunctionLike(current) && current !== node) return;
          if (ts.isIfStatement(current) && negatedName(current.expression) === parameter.text) {
            const offending = resetCalls(current.thenStatement).filter(
              (call) => !/Open$/.test(call)
            );
            if (offending.length > 0 && !hasCloseOk(source, current)) {
              report(
                current,
                `resets ${offending.join(", ")} while the dialog is closing; reset on open or after useDialogPresence ends`
              );
            }
          }
          ts.forEachChild(current, visit);
        };
        visit(node.body);
        return;
      }
      // 2. useEffect(() => { if (!open) resetSomething() }, [open]).
      if (ts.isCallExpression(node) && /^(?:React\.)?use(?:Layout)?Effect$/.test(node.expression.getText())) {
        const effect = unwrap(node.arguments[0]);
        if (!effect || !(ts.isArrowFunction(effect) || ts.isFunctionExpression(effect))) return;
        const visit = (current) => {
          if (ts.isFunctionLike(current) && current !== effect) return;
          if (ts.isIfStatement(current)) {
            const name = negatedName(current.expression);
            if (name && OPEN_NAME_RE.test(name)) {
              const offending = resetCalls(current.thenStatement);
              if (offending.length > 0 && !hasCloseOk(source, current)) {
                report(
                  current,
                  `resets ${offending.join(", ")} as soon as ${name} turns false; gate on useDialogPresence(${name}) instead`
                );
              }
            }
          }
          ts.forEachChild(current, visit);
        };
        visit(effect.body);
        return;
      }
      // 3. {payload && <SomeDialog payload={payload} />} unmounts the dialog without its exit animation.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        ts.isJsxExpression(node.parent)
      ) {
        const element = unwrap(node.right);
        const opening = element && openingOf(element);
        if (!opening || !OVERLAY_TAG_RE.test(tagName(opening))) return;
        const guard = identifiersIn(node.left);
        // A guard the open state does not follow (a permission, loaded page data) does not unmount on close.
        const openAttribute = attribute(opening, "open");
        if (openAttribute?.initializer) {
          const openNames = identifiersIn(openAttribute.initializer);
          if (![...guard].some((name) => openNames.has(name))) return;
        }
        const used = identifiersIn(opening.attributes);
        const shared = [...guard].filter((name) => used.has(name) && !/^(?:true|false|null|undefined)$/.test(name));
        if (shared.length > 0 && !hasCloseOk(source, node)) {
          report(
            node,
            `mounts ${tagName(opening)} only while ${shared.join(", ")} is set, so it vanishes without its exit animation; keep it mounted and retain the value with useRetainedDialogValue`
          );
        }
        return;
      }
      // 4. open={x !== null} with the content reading x directly.
      const opening = openingOf(node);
      if (!opening || !OVERLAY_TAG_RE.test(tagName(opening))) return;
      const openExpression = attribute(opening, "open")?.initializer;
      const payload = openExpression && ts.isJsxExpression(openExpression) && openPayload(openExpression.expression);
      if (!payload || !/^[A-Za-z_$][\w$]*$/.test(payload)) return;
      const reads = new RegExp(`(?<![\\w$.])${escapeRegExp(payload)}(?![\\w$])`);
      const rest = [
        ...opening.attributes.properties
          .filter((property) => !(ts.isJsxAttribute(property) && ["open", "onOpenChange", "key"].includes(property.name.getText())))
          .map((property) => property.getText()),
        ...(ts.isJsxElement(node) ? node.children.map((child) => child.getText()) : []),
      ];
      const readsPayload = rest.some((text) =>
        text
          .split(/\n/)
          .some((line) => reads.test(line.replace(new RegExp(`set\\w*\\(\\s*${escapeRegExp(payload)}`), "")))
      );
      if (readsPayload && !hasCloseOk(source, node)) {
        report(
          opening,
          `opens on ${payload} and renders it directly; the close clears it mid-animation — read useRetainedDialogValue(${payload}, open) instead`
        );
      }
    },
  },
];
