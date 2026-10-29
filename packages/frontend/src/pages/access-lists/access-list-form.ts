import { useEffect, useState } from "react";
import { toast } from "sonner";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type {
  AccessList,
  AccessRule,
  AccessRuleSelector,
  AccessSignInMethod,
  CreateAccessListRequest,
} from "@/types";
import { CHOICE_SELECTORS } from "./access-options";

export interface AccessListUserInput {
  _key: string;
  username: string;
  password: string;
}

export interface AddressInput {
  _key: string;
  value: string;
}

/**
 * One rule row. A typed selector keeps its values as the comma-separated `text` of its input; a
 * picked one (user, group, method, service token) keeps `values`.
 */
export interface AccessRuleInput {
  _key: string;
  selector: AccessRuleSelector;
  text: string;
  values: string[];
}

export type RuleKind = "include" | "require" | "exclude";

let accessListRowSequence = 0;
const nextRowKey = (prefix: string) => `${prefix}-${++accessListRowSequence}`;

export const newRuleInput = (
  selector: AccessRuleSelector = "email",
  values: string[] = []
): AccessRuleInput => ({ _key: nextRowKey("rule"), selector, text: values.join(", "), values });

const toRuleInputs = (rules: AccessRule[] | undefined) =>
  (rules ?? []).map((rule) => newRuleInput(rule.selector, rule.values));

/** The rule a row saves as, or null for a row left without a value. */
export function ruleFromInput(row: AccessRuleInput): AccessRule | null {
  if (row.selector === "everyone") return { selector: "everyone", values: [] };
  const values = CHOICE_SELECTORS.has(row.selector)
    ? row.values.filter(Boolean)
    : row.text
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  return values.length > 0 ? { selector: row.selector, values } : null;
}

const rulesFromInputs = (rows: AccessRuleInput[]) =>
  rows.map(ruleFromInput).filter((rule): rule is AccessRule => rule !== null);

/**
 * Rows left completely blank are ignored. Every other row needs a username, and a password
 * unless it keeps an existing user's stored password. Username sign-in without any user would
 * let nobody in, so it is rejected too.
 */
export function validateListUsers(
  rows: { username: string; password: string }[],
  existingUsernames: string[]
): { users: { username: string; password?: string }[] } | { error: string } {
  const users: { username: string; password?: string }[] = [];
  for (const row of rows) {
    const username = row.username.trim();
    if (!username && !row.password) continue;
    if (!username) return { error: "Enter a username for every user" };
    if (!row.password && !existingUsernames.includes(username)) {
      return { error: `Enter a password for user "${username}"` };
    }
    users.push(row.password ? { username, password: row.password } : { username });
  }
  if (users.length === 0) {
    return { error: "Add at least one user to sign in with a username and password" };
  }
  return { users };
}

/** Undefined keeps the stored shared password, null drops it, a string replaces it. */
function sharedPasswordChange(
  enabled: boolean,
  typed: string,
  stored: boolean
): string | null | undefined {
  if (enabled) return typed || undefined;
  return stored ? null : undefined;
}

/**
 * Form state of the create/edit access list dialog. It is filled from `accessList` (or emptied
 * for a new list) each time the dialog opens; stored passwords are never sent back, so existing
 * users and the shared password start blank and a blank one keeps what is stored.
 */
export function useAccessListForm({
  open,
  accessList,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  accessList: AccessList | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  /** Destination folder of a new list ("" is ungrouped); a list moves between folders in the list. */
  const [folderId, setFolderId] = useState("");
  const [description, setDescription] = useState("");
  const [sessionTtlSeconds, setSessionTtlSeconds] = useState<number | null>(null);
  const [methods, setMethods] = useState<AccessSignInMethod[]>([]);
  const [sharedPassword, setSharedPassword] = useState("");
  const [users, setUsers] = useState<AccessListUserInput[]>([]);
  const [skip, setSkip] = useState<AddressInput[]>([]);
  const [rules, setRules] = useState<Record<RuleKind, AccessRuleInput[]>>({
    include: [],
    require: [],
    exclude: [],
  });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(accessList?.name ?? "");
    setFolderId("");
    setDescription(accessList?.description || "");
    setSessionTtlSeconds(accessList?.sessionTtlSeconds ?? null);
    setMethods(accessList?.signInMethods ?? []);
    setSharedPassword("");
    setUsers(
      (accessList?.users ?? []).map((user) => ({
        _key: nextRowKey("user"),
        username: user.username,
        password: "",
      }))
    );
    setSkip((accessList?.skipIpRanges ?? []).map((value) => ({ _key: nextRowKey("skip"), value })));
    setRules({
      include: toRuleInputs(accessList?.includeRules),
      require: toRuleInputs(accessList?.requireRules),
      exclude: toRuleInputs(accessList?.excludeRules),
    });
  }, [open, accessList]);

  const setMethod = (key: AccessSignInMethod, enabled: boolean) =>
    setMethods((prev) => [...prev.filter((method) => method !== key), ...(enabled ? [key] : [])]);
  const usersShown = methods.includes("password") || methods.includes("basic");

  const addUser = () =>
    setUsers((prev) => [...prev, { _key: nextRowKey("user"), username: "", password: "" }]);
  const updateUser = (index: number, field: "username" | "password", value: string) =>
    setUsers((prev) => prev.map((user, at) => (at === index ? { ...user, [field]: value } : user)));
  const removeUser = (index: number) => setUsers((prev) => prev.filter((_, at) => at !== index));

  const addSkip = () => setSkip((prev) => [...prev, { _key: nextRowKey("skip"), value: "" }]);
  const updateSkip = (index: number, value: string) =>
    setSkip((prev) => prev.map((row, at) => (at === index ? { ...row, value } : row)));
  const removeSkip = (index: number) => setSkip((prev) => prev.filter((_, at) => at !== index));

  const setRuleRows = (kind: RuleKind, rows: AccessRuleInput[]) =>
    setRules((prev) => ({ ...prev, [kind]: rows }));

  const save = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }

    // Hidden users (no username method on) stay as they are.
    const storedUsernames = (accessList?.users ?? []).map((user) => user.username);
    let nextUsers: CreateAccessListRequest["users"] = storedUsernames.map((username) => ({
      username,
    }));
    if (usersShown) {
      const validation = validateListUsers(users, storedUsernames);
      if ("error" in validation) {
        toast.error(validation.error);
        return;
      }
      nextUsers = validation.users;
    }

    const sharedOn = methods.includes("shared");
    if (sharedOn && !sharedPassword && !accessList?.sharedPasswordSet) {
      toast.error("Enter the shared password");
      return;
    }

    setIsSaving(true);
    try {
      const data: CreateAccessListRequest = {
        name,
        // An empty string clears the stored description on edit.
        description: accessList ? description.trim() : description.trim() || undefined,
        signInMethods: methods,
        users: nextUsers,
        sharedPassword: sharedPasswordChange(
          sharedOn,
          sharedPassword,
          accessList?.sharedPasswordSet ?? false
        ),
        skipIpRanges: skip.map((row) => row.value.trim()).filter(Boolean),
        includeRules: rulesFromInputs(rules.include),
        requireRules: rulesFromInputs(rules.require),
        excludeRules: rulesFromInputs(rules.exclude),
        sessionTtlSeconds,
        ...(accessList ? {} : { folderId: folderId || null }),
      };

      if (accessList) {
        await api.updateAccessList(accessList.id, data);
        toast.success("Access list updated");
      } else {
        await api.createAccessList(data);
        toast.success("Access list created");
      }
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toastApiError(err, "Failed to save access list");
    } finally {
      setIsSaving(false);
    }
  };

  return {
    isEdit: accessList !== null,
    name,
    setName,
    folderId,
    setFolderId,
    description,
    setDescription,
    sessionTtlSeconds,
    setSessionTtlSeconds,
    methods,
    setMethod,
    sharedPassword,
    setSharedPassword,
    usersShown,
    users,
    addUser,
    updateUser,
    removeUser,
    skip,
    addSkip,
    updateSkip,
    removeSkip,
    rules,
    setRuleRows,
    isSaving,
    save,
  };
}

export type AccessListForm = ReturnType<typeof useAccessListForm>;
