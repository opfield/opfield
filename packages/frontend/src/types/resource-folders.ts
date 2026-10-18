export type ResourceFolderType =
  | `hosting-snapshot:${string}`
  | "node"
  | "domain"
  | "ssl-certificate"
  | "pki-ca"
  | "pki-certificate"
  | "pki-template"
  | "nginx-template"
  | "database"
  | "storage"
  | "logging-environment"
  | "logging-schema"
  | "admin-user"
  | "admin-group"
  | "pages-project"
  | "app"
  | "notification-alert-rule"
  | "notification-webhook"
  | "access-list";

export interface ResourceFolder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceFolderTreeNode extends ResourceFolder {
  children: ResourceFolderTreeNode[];
}

export interface FolderedResourceItem {
  folderId?: string | null;
  sortOrder?: number;
}
