import { arrayMove } from "@dnd-kit/sortable";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { AccessList, IPRule } from "@/types";

export interface BasicAuthUserInput {
  _key: string;
  username: string;
  password: string;
}

export type IPRuleInput = IPRule & { _key: string };

/**
 * Rows left completely blank are ignored. Every other row needs a username, and
 * a password unless it keeps an existing user's stored password. Basic auth
 * without any user would lock every visitor out, so it is rejected too.
 */
export function validateBasicAuthUsers(
  rows: { username: string; password: string }[],
  existingUsernames: string[]
): { users: { username: string; password: string }[] } | { error: string } {
  const users: { username: string; password: string }[] = [];
  for (const row of rows) {
    const username = row.username.trim();
    if (!username && !row.password) continue;
    if (!username) return { error: "Enter a username for every basic auth user" };
    if (!row.password && !existingUsernames.includes(username)) {
      return { error: `Enter a password for basic auth user "${username}"` };
    }
    users.push({ username, password: row.password });
  }
  if (users.length === 0) {
    return { error: "Add at least one user to enable basic authentication" };
  }
  return { users };
}

let accessListRowSequence = 0;
const nextRowKey = (prefix: string) => `${prefix}-${++accessListRowSequence}`;

/**
 * Form state of the create/edit access list dialog. It is filled from
 * `accessList` (or emptied for a new list) each time the dialog opens; stored
 * passwords are never sent back, so existing users start with a blank one.
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
  const [ipRules, setIpRules] = useState<IPRuleInput[]>([]);
  const [basicAuthEnabled, setBasicAuthEnabled] = useState(false);
  const [basicAuthUsers, setBasicAuthUsers] = useState<BasicAuthUserInput[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(accessList?.name ?? "");
    setFolderId("");
    setDescription(accessList?.description || "");
    setIpRules((accessList?.ipRules || []).map((rule) => ({ ...rule, _key: nextRowKey("ip") })));
    setBasicAuthEnabled(accessList?.basicAuthEnabled ?? false);
    setBasicAuthUsers(
      (accessList?.basicAuthUsers || []).map((user) => ({
        _key: nextRowKey("auth"),
        username: user.username,
        password: "",
      }))
    );
  }, [open, accessList]);

  const addIpRule = (rule: IPRule = { type: "allow", value: "" }) =>
    setIpRules((prev) => [...prev, { ...rule, _key: nextRowKey("ip") }]);
  const updateIpRule = (index: number, field: keyof IPRule, value: string) => {
    setIpRules((prev) =>
      prev.map((rule, candidateIndex) =>
        candidateIndex === index ? { ...rule, [field]: value } : rule
      )
    );
  };
  const removeIpRule = (index: number) => {
    setIpRules((prev) => prev.filter((_, candidateIndex) => candidateIndex !== index));
  };
  /** nginx checks the rules in this order and the first match wins. */
  const moveIpRule = (fromIndex: number, toIndex: number) => {
    setIpRules((prev) => arrayMove(prev, fromIndex, toIndex));
  };
  const addBasicAuthUser = (
    user: { username: string; password: string } = { username: "", password: "" }
  ) => {
    setBasicAuthUsers((prev) => [...prev, { ...user, _key: nextRowKey("auth") }]);
  };
  const updateBasicAuthUser = (index: number, field: "username" | "password", value: string) => {
    setBasicAuthUsers((prev) =>
      prev.map((user, candidateIndex) =>
        candidateIndex === index ? { ...user, [field]: value } : user
      )
    );
  };
  const removeBasicAuthUser = (index: number) => {
    setBasicAuthUsers((prev) => prev.filter((_, candidateIndex) => candidateIndex !== index));
  };

  const save = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }

    let nextBasicAuthUsers: { username: string; password: string }[] | undefined;
    if (basicAuthEnabled) {
      const validation = validateBasicAuthUsers(
        basicAuthUsers,
        accessList ? (accessList.basicAuthUsers ?? []).map((user) => user.username) : []
      );
      if ("error" in validation) {
        toast.error(validation.error);
        return;
      }
      nextBasicAuthUsers = validation.users;
    }

    setIsSaving(true);
    try {
      const data = {
        name,
        // An empty string clears the stored description on edit.
        description: accessList ? description.trim() : description.trim() || undefined,
        ipRules: ipRules
          .filter((rule) => rule.value.trim() !== "")
          .map(({ _key: _discarded, ...rule }) => rule),
        basicAuthEnabled,
        basicAuthUsers: nextBasicAuthUsers,
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
    ipRules,
    addIpRule,
    updateIpRule,
    removeIpRule,
    moveIpRule,
    basicAuthEnabled,
    setBasicAuthEnabled,
    basicAuthUsers,
    addBasicAuthUser,
    updateBasicAuthUser,
    removeBasicAuthUser,
    isSaving,
    save,
  };
}

export type AccessListForm = ReturnType<typeof useAccessListForm>;
