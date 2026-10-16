// Kept in step with packages/backend/src/modules/access-lists/ip-rule-analysis.ts, which returns the same
// warnings as ipRuleWarnings in the API. This copy runs in the dialog while the rules are edited.

export interface AccessListIpRuleLike {
  type: string;
  value: string;
}

/**
 * A rule that cannot change what nginx does. `shadowed`: an earlier rule matches every address this rule
 * matches, so nginx never reaches it. `no_effect`: a deny rule no later allow rule overlaps, so the addresses it
 * denies would be denied anyway by the `deny all;` Opfield renders after the last rule.
 */
export interface AccessListIpRuleWarning {
  /** 0-based position of the rule in ipRules. */
  index: number;
  kind: "shadowed" | "no_effect";
  /** shadowed: 0-based position of the earlier rule that covers this one. */
  coveredByIndex?: number;
  message: string;
}

type ParsedRule = { all: true } | { all: false; family: 4 | 6; network: bigint; prefix: number };

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (text.includes("%")) return null;
  let head = text;
  // An embedded IPv4 tail (::ffff:192.0.2.1) stands for the last two 16-bit words.
  const lastColon = head.lastIndexOf(":");
  if (lastColon !== -1 && head.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(head.slice(lastColon + 1));
    if (v4 === null) return null;
    head = `${head.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parseWords = (segment: string): number[] | null => {
    if (segment === "") return [];
    const words: number[] = [];
    for (const word of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(word)) return null;
      words.push(Number.parseInt(word, 16));
    }
    return words;
  };
  const left = parseWords(halves[0]);
  const right = halves.length === 2 ? parseWords(halves[1]) : [];
  if (!left || !right) return null;
  const explicit = left.length + right.length;
  let words: number[];
  if (halves.length === 2) {
    if (explicit > 7) return null;
    words = [...left, ...new Array<number>(8 - explicit).fill(0), ...right];
  } else {
    if (explicit !== 8) return null;
    words = left;
  }
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

function parseRule(value: string): ParsedRule | null {
  const text = value.trim();
  if (text === "all") return { all: true };
  const slash = text.indexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  let family: 4 | 6;
  let parsed: bigint | null;
  if (address.includes(":")) {
    family = 6;
    parsed = parseIpv6(address);
  } else {
    family = 4;
    parsed = parseIpv4(address);
  }
  if (parsed === null) return null;
  const bits = family === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const prefixText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > bits) return null;
  }
  // nginx ignores the host bits of a CIDR ("low address bits are meaningless").
  const shift = BigInt(bits - prefix);
  return { all: false, family, network: (parsed >> shift) << shift, prefix };
}

/** True when every client address `inner` matches is also matched by `outer`. */
function covers(outer: ParsedRule, inner: ParsedRule): boolean {
  if (outer.all) return true;
  if (inner.all) return false;
  // nginx keeps a separate rule list per address family (an IPv4-mapped IPv6 client is checked against the
  // IPv4 rules), so only `all` reaches across families.
  if (outer.family !== inner.family || outer.prefix > inner.prefix) return false;
  const shift = BigInt((outer.family === 4 ? 32 : 128) - outer.prefix);
  return inner.network >> shift === outer.network >> shift;
}

function overlaps(a: ParsedRule, b: ParsedRule): boolean {
  return covers(a, b) || covers(b, a);
}

function describe(rule: AccessListIpRuleLike, index: number): string {
  return `rule ${index + 1} (${rule.type} ${rule.value.trim()})`;
}

/**
 * Finds the rules of an access list that never change the outcome, in the order nginx checks them. Rules whose
 * value does not parse are skipped (the schema rejects them on save). Only single-rule coverage is detected: two
 * /25 ranges that together cover a later /24 do not mark it.
 */
export function analyzeAccessListIpRules(
  rules: readonly AccessListIpRuleLike[]
): AccessListIpRuleWarning[] {
  const parsed = rules.map((rule) => parseRule(rule.value));
  const warnings: AccessListIpRuleWarning[] = [];
  parsed.forEach((rule, index) => {
    if (!rule) return;
    const current = rules[index];
    const coveredByIndex = parsed.findIndex((earlier, earlierIndex) => {
      return earlierIndex < index && earlier !== null && covers(earlier, rule);
    });
    if (coveredByIndex !== -1) {
      const earlier = rules[coveredByIndex];
      const sameAction = earlier.type === current.type;
      warnings.push({
        index,
        kind: "shadowed",
        coveredByIndex,
        message: sameAction
          ? `Never matches: ${describe(earlier, coveredByIndex)} already ${earlier.type === "allow" ? "allows" : "denies"} every address it covers.`
          : `Never matches: ${describe(earlier, coveredByIndex)} ${earlier.type === "allow" ? "allows" : "denies"} these addresses first. Move this rule above it to ${current.type} them.`,
      });
      return;
    }
    if (current.type !== "deny" || rule.all) return;
    const laterAllow = parsed.some(
      (later, laterIndex) =>
        laterIndex > index &&
        later !== null &&
        rules[laterIndex].type === "allow" &&
        overlaps(later, rule)
    );
    if (!laterAllow) {
      warnings.push({
        index,
        kind: "no_effect",
        message:
          "Has no effect: no later rule allows these addresses, and addresses that match no rule are denied anyway.",
      });
    }
  });
  return warnings;
}
