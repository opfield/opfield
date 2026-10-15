import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Download,
  ExternalLink,
  File,
  FilePlus,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import type { ChangeEvent, DragEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import {
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import {
  CONTAINER_RECREATING_MESSAGE,
  CONTAINER_RECREATING_RETRY_MS,
} from "@/lib/container-stream-unavailable";
import { isImageFileName } from "@/lib/file-types";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { FileEntry, SystemConfig } from "@/types";
import { formatBytes } from "./helpers";
import { isContainerGoneError } from "./replaced-container";

// ── Types ────────────────────────────────────────────────────────

interface TreeNode extends FileEntry {
  path: string;
  children: TreeNode[] | null; // null = not loaded, [] = empty dir (or non-dir)
  expanded: boolean;
  loading: boolean;
}

const FILE_TABLE_COLUMNS: ResourceListColumn<TreeNode>[] = [
  { id: "name", label: "Name" },
  { id: "size", label: "Size", width: "6rem", align: "right" },
  { id: "modified", label: "Last Modified", width: "11rem" },
  { id: "mode", label: "Mode", width: "7rem" },
];

type ContextMenuState = {
  x: number;
  y: number;
  node: TreeNode | null;
};

type CreateDialogState = {
  type: "file" | "folder";
  directory: string;
};

type UploadProgressHandler = (progress: { loaded: number; total: number }) => void;

export type FileManagerOperations = {
  listDirectory?: (path: string) => Promise<FileEntry[]>;
  readFile?: (path: string) => Promise<ArrayBuffer>;
  openFile?: (path: string, writable?: boolean) => void;
  createFile?: (
    path: string,
    content: Blob | BufferSource | string,
    onProgress?: UploadProgressHandler
  ) => Promise<unknown>;
  createDirectory?: (path: string) => Promise<unknown>;
  deletePath?: (path: string) => Promise<unknown>;
  movePath?: (fromPath: string, toPath: string) => Promise<unknown>;
  initUpload?: (
    path: string,
    totalBytes: number
  ) => Promise<{ uploadId: string; chunkSize: number }>;
  uploadChunk?: (
    uploadId: string,
    offset: number,
    content: Blob,
    onProgress?: UploadProgressHandler
  ) => Promise<unknown>;
  completeUpload?: (uploadId: string, path: string, totalBytes: number) => Promise<unknown>;
  abortUpload?: (uploadId: string) => Promise<unknown>;
};

type DockerFileChangedPayload = {
  nodeId?: string;
  containerId?: string;
  volumeName?: string;
  action?: "created" | "updated" | "deleted" | "moved";
  path?: string;
  parentPath?: string;
  fromPath?: string;
  toPath?: string;
  fromParentPath?: string;
  toParentPath?: string;
};

const DEFAULT_FILE_OPEN_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const CHUNKED_UPLOAD_THRESHOLD_BYTES = 50 * 1024 * 1024;

function hasTruncatedListing(nodes: TreeNode[]): boolean {
  return nodes.some(
    (node) =>
      node._listTruncated === true ||
      (Array.isArray(node.children) && hasTruncatedListing(node.children))
  );
}

function canReadRegularFile(node: TreeNode) {
  if (node.isDir || node.isSymlink || node.isSpecial) return false;
  return true;
}

function isOpenableFile(node: TreeNode, openMaxBytes: number) {
  return canReadRegularFile(node) && node.size <= openMaxBytes;
}

function canCopyFileContents(node: TreeNode, openMaxBytes: number) {
  return canReadRegularFile(node) && !isImageFileName(node.name) && node.size <= openMaxBytes;
}

function parentPath(path: string) {
  const normalized = path.replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function normalizeFilePath(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
}

function joinPath(directory: string, name: string) {
  const cleanName = name.trim().replace(/^\/+/, "");
  return directory === "/" ? `/${cleanName}` : `${directory.replace(/\/+$/, "")}/${cleanName}`;
}

function sortFileEntries<T extends FileEntry>(entries: T[]) {
  return [...entries].sort((first, second) => {
    if (first.isDir !== second.isDir) return first.isDir ? -1 : 1;
    return first.name.localeCompare(second.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function isExternalFileDrag(event: DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function withMovedNodePaths(node: TreeNode, nextPath: string): TreeNode {
  return {
    ...node,
    path: nextPath,
    children:
      node.children?.map((child) => withMovedNodePaths(child, joinPath(nextPath, child.name))) ??
      node.children,
  };
}

function removeTreeNode(
  nodes: TreeNode[],
  sourcePath: string
): { nodes: TreeNode[]; removed: TreeNode | null } {
  let removed: TreeNode | null = null;
  const nextNodes: TreeNode[] = [];

  for (const node of nodes) {
    if (normalizeFilePath(node.path) === sourcePath) {
      removed = node;
      continue;
    }

    if (node.children) {
      const result = removeTreeNode(node.children, sourcePath);
      if (result.removed) {
        removed = result.removed;
        nextNodes.push({ ...node, children: result.nodes });
        continue;
      }
    }

    nextNodes.push(node);
  }

  return { nodes: nextNodes, removed };
}

function insertTreeNode(
  nodes: TreeNode[],
  targetDirectory: string,
  nodeToInsert: TreeNode
): TreeNode[] {
  if (targetDirectory === "/") {
    return sortFileEntries([...nodes, nodeToInsert]);
  }

  return nodes.map((node) => {
    if (normalizeFilePath(node.path) === targetDirectory) {
      if (!node.children) {
        return node;
      }
      return {
        ...node,
        children: sortFileEntries([...node.children, nodeToInsert]),
      };
    }
    if (node.children) {
      return { ...node, children: insertTreeNode(node.children, targetDirectory, nodeToInsert) };
    }
    return node;
  });
}

function findDirectoryChildren(nodes: TreeNode[], directory: string): TreeNode[] | null {
  if (directory === "/") return nodes;
  for (const node of nodes) {
    if (normalizeFilePath(node.path) === directory) {
      return node.children;
    }
    if (node.children) {
      const children = findDirectoryChildren(node.children, directory);
      if (children) return children;
    }
  }
  return null;
}

function moveTreeNode(
  nodes: TreeNode[],
  sourcePath: string,
  targetDirectory: string,
  destination: string
) {
  const removedResult = removeTreeNode(nodes, sourcePath);
  if (!removedResult.removed) return nodes;
  const movedNode = withMovedNodePaths(removedResult.removed, destination);
  return insertTreeNode(removedResult.nodes, targetDirectory, movedNode);
}

function isPathPending(path: string, pendingPaths: Set<string>) {
  const normalized = normalizeFilePath(path);
  for (const pendingPath of pendingPaths) {
    if (normalized === pendingPath || normalized.startsWith(`${pendingPath}/`)) {
      return true;
    }
  }
  return false;
}

// ── Component ────────────────────────────────────────────────────

export function FilesTab({
  nodeId,
  containerId,
  scopeResourceId,
  scopeNodeId = nodeId,
  canBrowse,
  canWrite,
  fetchDirectory,
  operations,
  realtimeEvent = "docker.file.changed",
  realtimeMatches,
  headerActions,
  description = "Browse and manage files in the selected container instance",
  onContainerUnavailable,
}: {
  nodeId: string;
  containerId?: string;
  scopeResourceId?: string;
  scopeNodeId?: string;
  canBrowse?: boolean;
  canWrite?: boolean;
  fetchDirectory?: (path: string) => Promise<FileEntry[]>;
  operations?: FileManagerOperations;
  realtimeEvent?: string | null;
  realtimeMatches?: (payload: DockerFileChangedPayload) => boolean;
  headerActions?: ReactNode;
  description?: string;
  /** The container ID is gone (a recreate replaced it): the page looks the container up again. */
  onContainerUnavailable?: () => void;
}) {
  const { hasScope } = useAuthStore();
  const onContainerUnavailableRef = useRef(onContainerUnavailable);
  onContainerUnavailableRef.current = onContainerUnavailable;
  // Bumped to list the root again while the container is being recreated.
  const [rootRetry, setRootRetry] = useState(0);
  const waitingForReplacementRef = useRef(false);
  const canBrowseFiles =
    canBrowse ??
    hasScope(
      `docker:containers:files:read:${scopeNodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`
    );
  const canWriteFiles =
    canWrite ??
    hasScope(
      `docker:containers:files:write:${scopeNodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`
    );
  const containerOperations = useMemo<FileManagerOperations | undefined>(() => {
    if (!containerId) return undefined;
    return {
      listDirectory: (path) => api.listContainerDir(nodeId, containerId, path),
      readFile: (path) => api.readContainerFile(nodeId, containerId, path),
      openFile: (filePath, writable) => {
        const params = new URLSearchParams({ path: filePath });
        if (writable && canWriteFiles) params.set("writable", "1");
        const url = `/docker/file/${nodeId}/${containerId}?${params}`;
        const fileName = filePath.split("/").pop() || "file";
        window.open(
          url,
          `file-${containerId}-${fileName}`,
          "width=900,height=600,menubar=no,toolbar=no"
        );
      },
      ...(canWriteFiles
        ? {
            createFile: (
              path: string,
              content: Blob | BufferSource | string,
              onProgress?: UploadProgressHandler
            ) => api.createContainerFile(nodeId, containerId, path, content, onProgress),
            createDirectory: (path: string) =>
              api.createContainerDirectory(nodeId, containerId, path),
            deletePath: (path: string) => api.deleteContainerFile(nodeId, containerId, path),
            movePath: (fromPath: string, toPath: string) =>
              api.moveContainerFile(nodeId, containerId, fromPath, toPath),
            initUpload: (path: string, totalBytes: number) =>
              api.initContainerFileUpload(nodeId, containerId, path, totalBytes),
            uploadChunk: (
              uploadId: string,
              offset: number,
              content: Blob,
              onProgress?: UploadProgressHandler
            ) =>
              api.uploadContainerFileChunk(
                nodeId,
                containerId,
                uploadId,
                offset,
                content,
                onProgress
              ),
            completeUpload: (uploadId: string, path: string, totalBytes: number) =>
              api.completeContainerFileUpload(nodeId, containerId, uploadId, path, totalBytes),
            abortUpload: (uploadId: string) =>
              api.abortContainerFileUpload(nodeId, containerId, uploadId),
          }
        : {}),
    };
  }, [canWriteFiles, containerId, nodeId]);
  const fileOperations = operations ?? containerOperations;
  const canReadFiles = !!fileOperations?.readFile;
  const canOpenFiles = !!fileOperations?.openFile;
  const canMutateFiles = !!(
    fileOperations?.createFile &&
    fileOperations.createDirectory &&
    fileOperations.deletePath
  );
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(canBrowseFiles);
  // The first root listing holds the tab; a later reload shows the in-table loading row.
  useContentLoading(isLoading);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isContextMenuVisible, setIsContextMenuVisible] = useState(false);
  const {
    open: createDialogOpen,
    value: createDialog,
    setValue: setCreateDialog,
    onOpenChange: onCreateDialogOpenChange,
  } = useDeferredDialogState<CreateDialogState>();
  const [newEntryName, setNewEntryName] = useState("");
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [pendingMovePaths, setPendingMovePaths] = useState<Set<string>>(() => new Set());
  const [uploadMaxBytes, setUploadMaxBytes] = useState(
    () =>
      api.getCached<SystemConfig>("system:config")?.fileUploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES
  );
  const [openMaxBytes, setOpenMaxBytes] = useState(
    () =>
      api.getCached<SystemConfig>("system:config")?.fileOpenMaxBytes ?? DEFAULT_FILE_OPEN_MAX_BYTES
  );
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadDirectoryRef = useRef("/");
  const rootsRef = useRef<TreeNode[]>([]);
  const pendingMovePathsRef = useRef(pendingMovePaths);
  const contextMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const nodeIdRef = useRef(nodeId);
  const containerIdRef = useRef(containerId ?? "");
  nodeIdRef.current = nodeId;
  containerIdRef.current = containerId ?? "";
  rootsRef.current = roots;
  pendingMovePathsRef.current = pendingMovePaths;

  const fetchDir = useCallback(
    async (dirPath: string): Promise<TreeNode[]> => {
      const data: FileEntry[] =
        fileOperations?.listDirectory !== undefined
          ? await fileOperations.listDirectory(dirPath)
          : fetchDirectory
            ? await fetchDirectory(dirPath)
            : await api.listContainerDir(nodeIdRef.current, containerIdRef.current, dirPath);
      return sortFileEntries(data ?? []).map((entry) => ({
        ...entry,
        path: dirPath === "/" ? `/${entry.name}` : `${dirPath}/${entry.name}`,
        children: entry.isDir ? null : [],
        expanded: false,
        loading: false,
      }));
    },
    [fetchDirectory, fileOperations]
  );

  const reloadDirectory = useCallback(
    async (dirPath: string) => {
      const children = await fetchDir(dirPath);
      if (dirPath === "/") {
        setRoots(children);
        return;
      }
      const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
          if (node.path === dirPath) {
            return { ...node, children, expanded: true, loading: false };
          }
          if (node.children) {
            return { ...node, children: updateNodes(node.children) };
          }
          return node;
        });
      setRoots((prev) => updateNodes(prev));
    },
    [fetchDir]
  );

  useRealtime(realtimeEvent, (payload) => {
    const event = payload as DockerFileChangedPayload;
    if (realtimeMatches) {
      if (!realtimeMatches(event)) return;
    } else if (event.nodeId !== nodeIdRef.current || event.containerId !== containerIdRef.current) {
      return;
    }

    const directories = new Set<string>();
    if (event.action === "moved") {
      directories.add(event.fromParentPath ?? parentPath(event.fromPath ?? event.path ?? "/"));
      directories.add(event.toParentPath ?? parentPath(event.toPath ?? event.path ?? "/"));
    } else {
      directories.add(event.parentPath ?? parentPath(event.path ?? "/"));
    }

    directories.forEach((directory) => {
      reloadDirectory(directory).catch(() => {
        /* the next explicit refresh will reconcile the tree */
      });
    });
  });

  const hasTruncatedDirectory = hasTruncatedListing(roots);

  const closeContextMenu = useCallback(() => {
    if (!contextMenu) return;
    setIsContextMenuVisible(false);
    if (contextMenuCloseTimerRef.current) {
      clearTimeout(contextMenuCloseTimerRef.current);
    }
    contextMenuCloseTimerRef.current = setTimeout(() => {
      setContextMenu(null);
      contextMenuCloseTimerRef.current = null;
    }, 100);
  }, [contextMenu]);

  useEffect(() => {
    api
      .getSystemConfig()
      .then((config) => {
        api.setCache("system:config", config);
        setUploadMaxBytes(config.fileUploadMaxBytes);
        setOpenMaxBytes(config.fileOpenMaxBytes);
      })
      .catch(() => {
        /* keep fallback limit */
      });
  }, []);

  // Load root on mount
  useEffect(() => {
    if (!canBrowseFiles) {
      setIsLoading(false);
      setRoots([]);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // A retry while waiting for a recreated container keeps its message instead of flashing the loader.
    void rootRetry;
    if (!waitingForReplacementRef.current) {
      setIsLoading(true);
      setLoadError(null);
    }
    fetchDir("/")
      .then((nodes) => {
        if (!cancelled) {
          setRoots(nodes);
          setIsLoading(false);
          setLoadError(null);
          waitingForReplacementRef.current = false;
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setRoots([]);
        setIsLoading(false);
        if (containerId && isContainerGoneError(err)) {
          // A recreate replaced this ID: wait for the replacement instead of failing.
          setLoadError(CONTAINER_RECREATING_MESSAGE);
          waitingForReplacementRef.current = true;
          onContainerUnavailableRef.current?.();
          retryTimer = setTimeout(() => setRootRetry((n) => n + 1), CONTAINER_RECREATING_RETRY_MS);
          return;
        }
        waitingForReplacementRef.current = false;
        setLoadError(err instanceof Error ? err.message : "Failed to list directory");
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [canBrowseFiles, containerId, fetchDir, rootRetry]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    window.addEventListener("click", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu, closeContextMenu]);

  useEffect(() => {
    return () => {
      if (contextMenuCloseTimerRef.current) {
        clearTimeout(contextMenuCloseTimerRef.current);
      }
    };
  }, []);

  // Toggle a directory open/closed
  const toggleDir = useCallback(
    async (path: string) => {
      const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
          if (node.path === path) {
            if (node.expanded) {
              // Collapse
              return { ...node, expanded: false };
            }
            // Expand — load children if needed
            if (node.children === null) {
              return { ...node, loading: true, expanded: true };
            }
            return { ...node, expanded: true };
          }
          if (node.children && node.expanded) {
            return { ...node, children: updateNodes(node.children) };
          }
          return node;
        });

      setRoots((prev) => updateNodes(prev));

      // Find the node to check if it needs loading
      const findNode = (nodes: TreeNode[]): TreeNode | null => {
        for (const n of nodes) {
          if (n.path === path) return n;
          if (n.children && n.expanded) {
            const found = findNode(n.children);
            if (found) return found;
          }
        }
        return null;
      };

      // We need to check current state — use a callback pattern
      setRoots((prev) => {
        const node = findNode(prev);
        if (node?.loading) {
          // Fetch in background, then update
          fetchDir(path)
            .then((children) => {
              const setChildren = (nodes: TreeNode[]): TreeNode[] =>
                nodes.map((n) => {
                  if (n.path === path) {
                    return { ...n, children, loading: false };
                  }
                  if (n.children && n.expanded) {
                    return { ...n, children: setChildren(n.children) };
                  }
                  return n;
                });
              setRoots((curr) => setChildren(curr));
            })
            .catch(() => {
              const setError = (nodes: TreeNode[]): TreeNode[] =>
                nodes.map((n) => {
                  if (n.path === path) {
                    return { ...n, children: [], loading: false, expanded: false };
                  }
                  if (n.children && n.expanded) {
                    return { ...n, children: setError(n.children) };
                  }
                  return n;
                });
              setRoots((curr) => setError(curr));
              toast.error("Failed to list directory");
            });
        }
        return prev; // no mutation here, async handles it
      });
    },
    [fetchDir]
  );

  // Open file in a separate window
  const openFile = useCallback(
    (filePath: string, writable?: boolean) => {
      fileOperations?.openFile?.(filePath, writable);
    },
    [fileOperations]
  );

  const readFileContent = useCallback(
    async (filePath: string) => {
      if (!fileOperations?.readFile) throw new Error("File read is unavailable");
      const bytes = await fileOperations.readFile(filePath);
      return new TextDecoder().decode(bytes);
    },
    [fileOperations]
  );

  const readFileBytes = useCallback(
    async (filePath: string) => {
      if (!fileOperations?.readFile) throw new Error("File read is unavailable");
      return fileOperations.readFile(filePath);
    },
    [fileOperations]
  );

  const openCreateDialog = useCallback(
    (type: "file" | "folder", directory: string) => {
      closeContextMenu();
      setCreateDialog({ type, directory });
      setNewEntryName("");
    },
    [closeContextMenu, setCreateDialog]
  );

  const handleCreateEntry = useCallback(async () => {
    if (isCreatingEntry) return;
    if (!createDialog || !fileOperations?.createFile || !fileOperations.createDirectory) return;
    const name = newEntryName.trim();
    if (!name || name.includes("/")) {
      toast.error("Enter a name without slashes");
      return;
    }
    const existingEntries = findDirectoryChildren(rootsRef.current, createDialog.directory);
    if (existingEntries?.some((entry) => entry.name === name)) {
      toast.error(`${createDialog.type === "file" ? "File" : "Folder"} already exists`);
      return;
    }
    const path = joinPath(createDialog.directory, name);
    setIsCreatingEntry(true);
    try {
      if (createDialog.type === "file") {
        await fileOperations.createFile(path, "");
        toast.success("File created");
      } else {
        await fileOperations.createDirectory(path);
        toast.success("Folder created");
      }
      setCreateDialog(null);
      await reloadDirectory(createDialog.directory);
    } catch (err) {
      toastApiError(err, `Failed to create ${createDialog.type}`);
    } finally {
      setIsCreatingEntry(false);
    }
  }, [
    createDialog,
    fileOperations,
    isCreatingEntry,
    newEntryName,
    reloadDirectory,
    setCreateDialog,
  ]);

  const handleUploadClick = useCallback(
    (directory: string) => {
      closeContextMenu();
      uploadDirectoryRef.current = directory;
      uploadInputRef.current?.click();
    },
    [closeContextMenu]
  );

  const uploadFiles = useCallback(
    async (directory: string, files: globalThis.File[]) => {
      if (!fileOperations?.createFile) return;
      if (files.length === 0) return;
      const oversized = files.filter((file) => file.size > uploadMaxBytes);
      if (oversized.length > 0) {
        toast.error(
          oversized.length === 1
            ? `File too large to upload (${formatBytes(oversized[0].size)}, max ${formatBytes(uploadMaxBytes)})`
            : `${oversized.length} files are too large to upload (max ${formatBytes(uploadMaxBytes)})`
        );
      }
      const uploadable = files.filter((file) => file.size <= uploadMaxBytes);
      if (uploadable.length === 0) {
        return;
      }
      const totalBytes = uploadable.reduce((sum, file) => sum + file.size, 0);
      let completedBytes = 0;
      let uploaded = 0;
      const toastId = toast.loading(
        uploadable.length === 1 ? "Uploading file..." : "Uploading files...",
        {
          description: totalBytes > 0 ? `0% of ${formatBytes(totalBytes)}` : "Starting upload",
          duration: Infinity,
          dismissible: false,
        }
      );
      try {
        for (const file of uploadable) {
          const path = joinPath(directory, file.name);
          const updateProgress = (fileUploadedBytes: number) => {
            const currentBytes = Math.min(totalBytes, completedBytes + fileUploadedBytes);
            const percent = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : 100;
            toast.loading(
              uploadable.length === 1 ? `Uploading ${file.name}...` : "Uploading files...",
              {
                id: toastId,
                description: `${percent}% (${formatBytes(currentBytes)} / ${formatBytes(totalBytes)})`,
                duration: Infinity,
                dismissible: false,
              }
            );
          };

          if (
            file.size > CHUNKED_UPLOAD_THRESHOLD_BYTES &&
            fileOperations.initUpload &&
            fileOperations.uploadChunk &&
            fileOperations.completeUpload &&
            fileOperations.abortUpload
          ) {
            const { uploadId, chunkSize } = await fileOperations.initUpload(path, file.size);
            let chunkOffset = 0;
            try {
              while (chunkOffset < file.size) {
                const chunk = file.slice(chunkOffset, Math.min(file.size, chunkOffset + chunkSize));
                const offsetForProgress = chunkOffset;
                await fileOperations.uploadChunk(uploadId, chunkOffset, chunk, ({ loaded }) =>
                  updateProgress(offsetForProgress + loaded)
                );
                chunkOffset += chunk.size;
                updateProgress(chunkOffset);
              }
              await fileOperations.completeUpload(uploadId, path, file.size);
            } catch (err) {
              await fileOperations.abortUpload(uploadId).catch(() => undefined);
              throw err;
            }
          } else {
            await fileOperations.createFile(path, file, ({ loaded }) => {
              updateProgress(loaded);
            });
          }
          completedBytes += file.size;
          uploaded += 1;
        }
        toast.success(uploaded === 1 ? "File uploaded" : `${uploaded} files uploaded`, {
          id: toastId,
          duration: 5000,
          dismissible: true,
        });
        await reloadDirectory(directory);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to upload file", {
          id: toastId,
          duration: 8000,
          dismissible: true,
        });
      }
    },
    [fileOperations, reloadDirectory, uploadMaxBytes]
  );

  const handleUploadChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      void uploadFiles(uploadDirectoryRef.current, files);
    },
    [uploadFiles]
  );

  const handleExternalDrop = useCallback(
    (event: DragEvent, directory: string) => {
      if (!canMutateFiles || !isExternalFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void uploadFiles(directory, Array.from(event.dataTransfer.files));
    },
    [canMutateFiles, uploadFiles]
  );

  const handleExternalDragOver = useCallback(
    (event: DragEvent) => {
      if (!canMutateFiles || !isExternalFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [canMutateFiles]
  );

  const handleMovePath = useCallback(
    async (source: TreeNode, targetDirectory: string) => {
      if (!fileOperations?.movePath) return;
      const normalizedSourcePath = normalizeFilePath(source.path);
      const normalizedTargetDirectory = normalizeFilePath(targetDirectory);
      const destination = joinPath(normalizedTargetDirectory, source.name);
      const normalizedDestination = normalizeFilePath(destination);
      if (
        isPathPending(normalizedSourcePath, pendingMovePathsRef.current) ||
        isPathPending(normalizedTargetDirectory, pendingMovePathsRef.current)
      ) {
        return;
      }
      if (destination === normalizedSourcePath) return;
      if (
        source.isDir &&
        (normalizedTargetDirectory === normalizedSourcePath ||
          normalizedTargetDirectory.startsWith(`${normalizedSourcePath}/`))
      ) {
        return;
      }
      const previousRoots = rootsRef.current;
      const nextRoots = moveTreeNode(
        previousRoots,
        normalizedSourcePath,
        normalizedTargetDirectory,
        destination
      );
      rootsRef.current = nextRoots;
      setRoots(nextRoots);
      setPendingMovePaths((prev) => {
        const next = new Set(prev);
        next.add(normalizedDestination);
        pendingMovePathsRef.current = next;
        return next;
      });
      try {
        await fileOperations.movePath(source.path, destination);
      } catch (err) {
        rootsRef.current = previousRoots;
        setRoots(previousRoots);
        toastApiError(err, "Failed to move file");
      } finally {
        setPendingMovePaths((prev) => {
          const next = new Set(prev);
          next.delete(normalizedDestination);
          pendingMovePathsRef.current = next;
          return next;
        });
      }
    },
    [fileOperations]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const source = event.active.data.current?.node as TreeNode | undefined;
      const targetDirectory = event.over?.data.current?.path as string | undefined;
      if (!source || !targetDirectory) return;
      void handleMovePath(source, targetDirectory);
    },
    [handleMovePath]
  );

  const handleCopyFile = useCallback(
    async (node: TreeNode) => {
      closeContextMenu();
      if (!canCopyFileContents(node, openMaxBytes)) return;
      try {
        await navigator.clipboard.writeText(await readFileContent(node.path));
        toast.success("File content copied");
      } catch (err) {
        toastApiError(err, "Failed to copy file");
      }
    },
    [closeContextMenu, openMaxBytes, readFileContent]
  );

  const handleDownloadFile = useCallback(
    async (node: TreeNode) => {
      closeContextMenu();
      if (!canReadRegularFile(node)) return;
      try {
        const bytes = await readFileBytes(node.path);
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = node.name || "file";
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        toastApiError(err, "Failed to download file");
      }
    },
    [closeContextMenu, readFileBytes]
  );

  const handleDeletePath = useCallback(
    async (node: TreeNode) => {
      closeContextMenu();
      if (!fileOperations?.deletePath) return;
      const confirmed = await confirm({
        title: node.isDir ? "Delete Folder" : "Delete File",
        description: `Delete "${node.path}"? This cannot be undone.`,
        confirmLabel: "Delete",
        variant: "destructive",
      });
      if (!confirmed) return;
      try {
        await fileOperations.deletePath(node.path);
        toast.success(node.isDir ? "Folder deleted" : "File deleted");
        await reloadDirectory(parentPath(node.path));
      } catch (err) {
        toastApiError(err, "Failed to delete");
      }
    },
    [closeContextMenu, fileOperations, reloadDirectory]
  );

  const openContextMenu = useCallback((event: MouseEvent, node: TreeNode | null) => {
    if (event.shiftKey) return;
    if (node && isPathPending(node.path, pendingMovePathsRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    if (contextMenuCloseTimerRef.current) {
      clearTimeout(contextMenuCloseTimerRef.current);
      contextMenuCloseTimerRef.current = null;
    }
    setIsContextMenuVisible(false);
    setContextMenu({ x: event.clientX, y: event.clientY, node });
    requestAnimationFrame(() => setIsContextMenuVisible(true));
  }, []);

  if (!canBrowseFiles) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        You don't have permission to browse files.
      </div>
    );
  }

  return (
    <div className="select-none pb-6">
      <input
        ref={uploadInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={handleUploadChange}
      />
      <PanelShell
        title="Files"
        description={description}
        actions={headerActions}
        bodyClassName="min-w-0"
      >
        {hasTruncatedDirectory && (
          <Notice
            tone="warning"
            role="status"
            className="border-x-0 border-t-0"
            title="Some directories are truncated"
          >
            They show only the first{" "}
            {roots.find((entry) => entry._listTruncated)?._listLimit ?? 1000} entries.
          </Notice>
        )}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <RootDropZone
            disabled={!canMutateFiles}
            onDropFiles={handleExternalDrop}
            onDragOverFiles={handleExternalDragOver}
          >
            <div onContextMenu={(event) => openContextMenu(event, null)}>
              <ResourceListFrame minWidth={900} className="border-0">
                <ResourceListHeaderTable columns={FILE_TABLE_COLUMNS} />
                <ResourceListTable
                  columns={FILE_TABLE_COLUMNS}
                  bodyClassName="divide-y divide-border"
                >
                  {isLoading && (
                    <tr>
                      <td
                        colSpan={FILE_TABLE_COLUMNS.length}
                        className="p-8 text-center text-muted-foreground text-sm"
                      >
                        <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                        Loading...
                      </td>
                    </tr>
                  )}
                  {!isLoading && loadError && (
                    <tr>
                      <td
                        colSpan={FILE_TABLE_COLUMNS.length}
                        className="p-8 text-center text-muted-foreground text-sm"
                      >
                        {loadError}
                      </td>
                    </tr>
                  )}
                  {!isLoading && !loadError && roots.length === 0 && (
                    <tr>
                      <td
                        colSpan={FILE_TABLE_COLUMNS.length}
                        className="p-8 text-center text-muted-foreground text-sm"
                      >
                        Empty directory
                      </td>
                    </tr>
                  )}
                  {!isLoading &&
                    roots.map((node) => (
                      <TreeRow
                        key={node.path}
                        node={node}
                        depth={0}
                        canDrag={canMutateFiles && !!fileOperations?.movePath}
                        pendingMovePaths={pendingMovePaths}
                        openMaxBytes={openMaxBytes}
                        onToggle={toggleDir}
                        onOpenFile={canOpenFiles ? openFile : undefined}
                        onContextMenu={openContextMenu}
                        onDropFiles={handleExternalDrop}
                        onDragOverFiles={handleExternalDragOver}
                      />
                    ))}
                </ResourceListTable>
              </ResourceListFrame>
            </div>
          </RootDropZone>
        </DndContext>
      </PanelShell>
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          canMutate={canMutateFiles}
          canRead={canReadFiles}
          canOpen={canOpenFiles}
          openMaxBytes={openMaxBytes}
          uploadMaxBytes={uploadMaxBytes}
          visible={isContextMenuVisible}
          onCreateFile={(directory) => openCreateDialog("file", directory)}
          onCreateFolder={(directory) => openCreateDialog("folder", directory)}
          onUpload={handleUploadClick}
          onOpenFile={(node) => {
            closeContextMenu();
            openFile(node.path, node.isWritable);
          }}
          onCopyFile={handleCopyFile}
          onDownloadFile={handleDownloadFile}
          onDelete={handleDeletePath}
        />
      )}
      <Dialog open={createDialogOpen} onOpenChange={onCreateDialogOpenChange}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {createDialog?.type === "folder" ? "Create Folder" : "Create File"}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newEntryName}
            onChange={(event) => setNewEntryName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreateEntry();
            }}
            placeholder={createDialog?.type === "folder" ? "folder-name" : "file-name"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateEntry}
              pending={isCreatingEntry}
              disabled={!newEntryName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FileContextMenu({
  x,
  y,
  node,
  canMutate,
  canRead,
  canOpen: canOpenInViewer,
  openMaxBytes,
  uploadMaxBytes,
  visible,
  onCreateFile,
  onCreateFolder,
  onUpload,
  onOpenFile,
  onCopyFile,
  onDownloadFile,
  onDelete,
}: {
  x: number;
  y: number;
  node: TreeNode | null;
  canMutate: boolean;
  canRead: boolean;
  canOpen: boolean;
  openMaxBytes: number;
  /** The file upload limit, shown on the upload item: larger files are refused before they are sent. */
  uploadMaxBytes: number;
  visible: boolean;
  onCreateFile: (directory: string) => void;
  onCreateFolder: (directory: string) => void;
  onUpload: (directory: string) => void;
  onOpenFile: (node: TreeNode) => void;
  onCopyFile: (node: TreeNode) => void;
  onDownloadFile: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
}) {
  const targetDirectory = node?.isDir ? node.path : parentPath(node?.path ?? "/");
  const canOpen = !!node && isOpenableFile(node, openMaxBytes);
  const canFileRead = canRead && !!node && canCopyFileContents(node, openMaxBytes);
  const canDownload = canRead && !!node && canReadRegularFile(node);
  const menuStyle = {
    left: Math.max(8, Math.min(x, window.innerWidth - 260)),
    top: Math.max(8, Math.min(y, window.innerHeight - 320)),
  };

  return (
    <div
      className={`dropdown-content fixed z-50 min-w-60 origin-top-left border bg-popover p-1 text-popover-foreground shadow-sm transition duration-100 ease-out ${
        visible ? "scale-100 opacity-100" : "scale-95 opacity-0"
      }`}
      style={menuStyle}
      onClick={(event) => event.stopPropagation()}
      role="menu"
    >
      <FileContextMenuItem
        icon={<FilePlus />}
        label="Create file"
        disabled={!canMutate}
        onSelect={() => onCreateFile(targetDirectory)}
      />
      {node?.isDir && (
        <FileContextMenuItem
          icon={<FilePlus />}
          label="Create file in parent"
          disabled={!canMutate}
          onSelect={() => onCreateFile(parentPath(node.path))}
        />
      )}
      <FileContextMenuItem
        icon={<FolderPlus />}
        label="Create folder"
        disabled={!canMutate}
        onSelect={() => onCreateFolder(targetDirectory)}
      />
      {node?.isDir && (
        <FileContextMenuItem
          icon={<FolderPlus />}
          label="Create folder in parent"
          disabled={!canMutate}
          onSelect={() => onCreateFolder(parentPath(node.path))}
        />
      )}
      <FileContextMenuItem
        icon={<Upload />}
        label="Upload file"
        hint={`up to ${formatBytes(uploadMaxBytes)}`}
        disabled={!canMutate}
        onSelect={() => onUpload(targetDirectory)}
      />
      <FileContextMenuSeparator />
      <FileContextMenuItem
        icon={<ExternalLink />}
        label="Open file"
        disabled={!canOpenInViewer || !canOpen}
        onSelect={() => node && onOpenFile(node)}
      />
      <FileContextMenuItem
        icon={<ClipboardCopy />}
        label="Copy contents"
        disabled={!canFileRead}
        onSelect={() => node && onCopyFile(node)}
      />
      <FileContextMenuItem
        icon={<Download />}
        label="Download file"
        disabled={!canDownload}
        onSelect={() => node && onDownloadFile(node)}
      />
      <FileContextMenuSeparator />
      <FileContextMenuItem
        icon={<Trash2 />}
        label={node?.isDir ? "Delete folder" : "Delete file"}
        disabled={!canMutate || !node}
        destructive
        onSelect={() => node && onDelete(node)}
      />
      <FileContextMenuSeparator />
      <FileContextMenuItem label="Shift + right click for browser menu" disabled />
    </div>
  );
}

function FileContextMenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-muted" />;
}

function FileContextMenuItem({
  icon,
  label,
  hint,
  disabled,
  destructive,
  onSelect = () => {},
}: {
  icon?: ReactNode;
  label: string;
  /** Muted text at the end of the item, as a dropdown menu shortcut. */
  hint?: string;
  disabled?: boolean;
  destructive?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={`relative flex w-full select-none items-center gap-2 px-2 py-3 text-left text-sm outline-none transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 md:py-1.5 [&>svg]:size-4 [&>svg]:shrink-0 ${
        destructive ? "text-destructive" : ""
      }`}
      onClick={onSelect}
    >
      {icon}
      {label}
      {hint && <span className="ml-auto pl-4 text-xs text-muted-foreground">{hint}</span>}
    </button>
  );
}

// ── Tree Row (recursive) ─────────────────────────────────────────

function TreeRow({
  node,
  depth,
  canDrag,
  pendingMovePaths,
  openMaxBytes,
  onToggle,
  onOpenFile,
  onContextMenu,
  onDropFiles,
  onDragOverFiles,
}: {
  node: TreeNode;
  depth: number;
  canDrag: boolean;
  pendingMovePaths: Set<string>;
  openMaxBytes: number;
  onToggle: (path: string) => void;
  onOpenFile?: (path: string, writable?: boolean) => void;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onDropFiles: (event: DragEvent, directory: string) => void;
  onDragOverFiles: (event: DragEvent) => void;
}) {
  const indent = depth * 20;
  const isOpenable = !!onOpenFile && isOpenableFile(node, openMaxBytes);
  const isPendingMove = isPathPending(node.path, pendingMovePaths);
  const canInteract = !isPendingMove;
  const effectiveCanDrag = canDrag && canInteract;
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `file:${node.path}`,
    data: { node },
    disabled: !effectiveCanDrag,
  });
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `dir:${node.path}`,
    data: { path: node.path },
    disabled: !effectiveCanDrag || !node.isDir,
  });
  const setRowRef = useCallback(
    (element: HTMLTableRowElement | null) => {
      setDraggableRef(element);
      setDroppableRef(element);
    },
    [setDraggableRef, setDroppableRef]
  );
  const dragStyle = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.3 : isPendingMove ? 0.65 : 1,
  };

  const handleClick = () => {
    if (!canInteract) return;
    if (node.isDir) {
      onToggle(node.path);
    }
  };

  const handleDoubleClick = () => {
    if (!canInteract) return;
    if (node.isDir) return;
    if (!isOpenable) {
      if (node.size > openMaxBytes) {
        toast.error(
          `File too large to open (${formatBytes(node.size)}, max ${formatBytes(openMaxBytes)})`
        );
      }
    } else {
      onOpenFile?.(node.path, node.isWritable);
    }
  };

  return (
    <>
      <tr
        ref={setRowRef}
        style={dragStyle}
        className={
          !isOpenable && !node.isDir
            ? "transition-colors"
            : `transition-colors ${canInteract ? "cursor-pointer" : "cursor-wait"} ${
                isOver ? "bg-accent/30" : canInteract ? "hover:bg-accent" : ""
              }`
        }
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={canInteract ? (event) => onContextMenu(event, node) : undefined}
        onDragOver={effectiveCanDrag && node.isDir ? onDragOverFiles : undefined}
        onDrop={
          effectiveCanDrag && node.isDir ? (event) => onDropFiles(event, node.path) : undefined
        }
        {...(effectiveCanDrag ? attributes : {})}
        {...(effectiveCanDrag ? listeners : {})}
      >
        <td className="p-3 text-sm">
          <div className="flex items-center gap-1.5" style={{ paddingLeft: indent }}>
            {node.isDir ? (
              <>
                {node.loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                ) : node.expanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                {node.expanded ? (
                  <FolderOpen className="h-4 w-4 text-tone-blue shrink-0" />
                ) : (
                  <Folder className="h-4 w-4 text-tone-blue shrink-0" />
                )}
              </>
            ) : (
              <>
                <span className="w-3.5 shrink-0" />
                {node.isSymlink ? (
                  <FileSymlink className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <File className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </>
            )}
            <span className="truncate">{node.name}</span>
            {node.linkTarget && (
              <span className="text-muted-foreground truncate">&rarr; {node.linkTarget}</span>
            )}
          </div>
        </td>
        <td className="p-3 text-sm text-muted-foreground text-right font-mono">
          {node.isDir ? "-" : formatBytes(node.size)}
        </td>
        <td className="p-3 text-sm text-muted-foreground">{node.modified || "-"}</td>
        <td className="p-3 text-sm text-muted-foreground font-mono">{node.permissions || "-"}</td>
      </tr>
      {node.isDir &&
        node.expanded &&
        node.children?.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            canDrag={canDrag}
            pendingMovePaths={pendingMovePaths}
            openMaxBytes={openMaxBytes}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            onDropFiles={onDropFiles}
            onDragOverFiles={onDragOverFiles}
          />
        ))}
    </>
  );
}

function RootDropZone({
  children,
  disabled,
  onDropFiles,
  onDragOverFiles,
}: {
  children: ReactNode;
  disabled: boolean;
  onDropFiles: (event: DragEvent, directory: string) => void;
  onDragOverFiles: (event: DragEvent) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: "dir:/",
    data: { path: "/" },
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={isOver ? "bg-accent/30" : undefined}
      onDragOver={disabled ? undefined : onDragOverFiles}
      onDrop={disabled ? undefined : (event) => onDropFiles(event, "/")}
    >
      {children}
    </div>
  );
}
