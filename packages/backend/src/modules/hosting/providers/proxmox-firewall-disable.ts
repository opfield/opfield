import { firewallFingerprint } from '../hosting-firewall.types.js';
import { HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';

type Rule = Record<string, string | number | undefined>;
type Options = Record<string, string | number | boolean | undefined>;
type Request = <T>(path: string, options?: HostingRequestOptions) => Promise<T>;
const enabled = (rule: Rule) => rule.enable === undefined || Number(rule.enable) !== 0;
const on = (options: Options) => Number(options.enable) === 1;
function conflict(): never {
  throw new HostingProviderError(409, true, 'VM firewall changed while disabling; review the current provider state.');
}

/** Restore only our binding after a failed staged-policy validation on an already enabled VM. */
export async function restoreProxmoxFirewallBinding(
  base: string,
  previous: Rule,
  stagedGroup: string,
  request: Request,
  readRules: (path: string) => Promise<Rule[]>,
  /** The binding PUT may have rewritten a legacy comment to the current one. */
  bindingComment: string | number | undefined = previous.comment
) {
  const ours = (rule: Rule) =>
    rule.type === 'group' && (rule.comment === previous.comment || rule.comment === bindingComment);
  const rules = await readRules(`${base}/firewall/rules`);
  const matches = rules.filter(ours);
  const binding = matches[0];
  if (
    matches.length !== 1 ||
    !binding ||
    binding.action !== stagedGroup ||
    typeof binding.pos !== 'number' ||
    typeof binding.digest !== 'string'
  )
    conflict();
  await request(`${base}/firewall/rules/${binding.pos}`, {
    method: 'PUT',
    body: { action: previous.action, enable: previous.enable ?? 1, digest: binding.digest },
  });
  const after = await readRules(`${base}/firewall/rules`);
  if (!after.some((rule) => ours(rule) && rule.action === previous.action && enabled(rule) === enabled(previous)))
    conflict();
}

/** Inactive ownership anchors make interrupted disable recoverable without altering foreign rules. */
export async function disableProxmoxFirewall(
  current: {
    base: string;
    options: Options;
    vmRules: Rule[];
    ownBindings: Rule[];
    bindingComment: string;
    legacyBindingComment?: string;
  },
  request: Request,
  readRules: (path: string) => Promise<Rule[]>
) {
  const path = `${current.base}/firewall/rules`;
  const optionsPath = `${current.base}/firewall/options`;
  const owned = (rule: Rule) =>
    rule.type === 'group' &&
    (rule.comment === current.bindingComment ||
      (current.legacyBindingComment !== undefined && rule.comment === current.legacyBindingComment));
  let rules = await readRules(path);
  if (firewallFingerprint(rules) !== firewallFingerprint(current.vmRules)) conflict();
  for (const binding of current.ownBindings.filter(enabled)) {
    const match = rules.find((rule) => owned(rule) && rule.action === binding.action && rule.pos === binding.pos);
    if (!match || typeof match.pos !== 'number' || typeof match.digest !== 'string') conflict();
    await request(`${path}/${match.pos}`, { method: 'PUT', body: { enable: 0, digest: match.digest } });
    rules = await readRules(path);
  }
  if (rules.some((rule) => owned(rule) && enabled(rule))) conflict();
  if (rules.some((rule) => !owned(rule) && enabled(rule))) return;
  const options = await request<Options>(optionsPath);
  if (firewallFingerprint(options) !== firewallFingerprint(current.options)) conflict();
  if (!on(options)) return;
  await request(optionsPath, { method: 'PUT', body: { enable: 0, digest: options.digest } });
  const after = await readRules(path);
  if (!after.some(enabled)) return;
  // Options and rules have separate CAS digests: verify and recover a crossed foreign-rule write.
  const observed = await request<Options>(optionsPath);
  const { digest: _old, ...beforeValues } = options;
  const { digest: _new, ...afterValues } = observed;
  if (on(observed)) return;
  if (firewallFingerprint({ ...beforeValues, enable: 0 }) !== firewallFingerprint(afterValues)) conflict();
  await request(optionsPath, { method: 'PUT', body: { enable: 1, digest: observed.digest } });
  if (!on(await request<Options>(optionsPath))) conflict();
}
