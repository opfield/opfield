import { describe, expect, it } from "vitest";
import {
  type AppScopeApp,
  appFolderOptions,
  buildRestrictionRows,
  type FolderOption,
  type ResourceOption,
  type RestrictionRow,
} from "./scope-list-helpers";

const apps: AppScopeApp[] = [
  {
    id: "app-foss",
    name: "Foss Design",
    environments: [
      {
        id: "env-foss-prod",
        name: "production",
        memberCounts: {},
        folderIds: { pages: "f-foss-prod" },
      },
    ],
    rootFolderIds: { pages: "f-foss-root" },
  },
  {
    id: "app-opfield",
    name: "Opfield",
    environments: [
      {
        id: "env-op-prod",
        name: "production",
        memberCounts: {},
        folderIds: { pages: "f-op-prod" },
      },
      { id: "env-op-stage", name: "staging", memberCounts: {}, folderIds: { pages: "f-op-stage" } },
    ],
    rootFolderIds: { pages: "f-op-root" },
  },
];

const userFolder: FolderOption = {
  id: "f-sites",
  label: "sites",
  family: "pages",
  ancestorIds: [],
};
const resources: ResourceOption[] = [
  { id: "node/n1", label: "edge-1" },
  { id: "p-blog", label: "Blog", folderId: "f-sites" },
  { id: "p-landing", label: "Opfield Landing", folderId: "f-op-prod" },
  { id: "p-loose", label: "Loose" },
  { id: "p-hidden-folder", label: "In a folder I cannot list", folderId: "f-unknown" },
];

const summary = (rows: RestrictionRow[]) =>
  rows.map((row) =>
    row.type === "resource"
      ? `${row.depth} resource ${row.resource.label}`
      : `${row.depth} ${row.type} ${row.label}`
  );

const pagesRows = (
  canSelectAppFolder: (folder: FolderOption) => boolean = () => true,
  chosen?: string
) =>
  buildRestrictionRows({
    family: "pages",
    resourceOptions: resources,
    folders: [userFolder],
    knownFolders: [userFolder],
    appFolders: appFolderOptions(apps).filter((folder) => folder.family === "pages"),
    canSelectAppFolder,
    isAppFolderChosen: (folder) => folder.id === chosen,
  });

describe("buildRestrictionRows", () => {
  it("lists an app-owned Pages project under its app and environment", () => {
    expect(summary(pagesRows())).toEqual([
      "0 folder sites",
      "1 resource Blog",
      "0 folder Opfield",
      "1 folder production",
      "2 resource Opfield Landing",
      "0 resource edge-1",
      "0 resource Loose",
      "0 resource In a folder I cannot list",
    ]);
    const rows = pagesRows();
    const landing = rows.findIndex(
      (row) => row.type === "resource" && row.resource.id === "p-landing"
    );
    const environment = rows[landing - 1];
    const app = rows[landing - 2];
    expect(environment?.type === "folder" && environment.folder.id).toBe("f-op-prod");
    expect(app?.type === "folder" && app.folder.id).toBe("f-op-root");
  });

  it("lists a named app environment even while it holds nothing of this kind", () => {
    expect(summary(pagesRows(undefined, "f-foss-prod")).slice(2, 4)).toEqual([
      "0 folder Foss Design",
      "1 folder production",
    ]);
  });

  it("shows apps and environments the user may not grant whole as headings, with their members", () => {
    expect(summary(pagesRows(() => false))).toEqual([
      "0 folder sites",
      "1 resource Blog",
      "0 group Opfield",
      "1 group production",
      "2 resource Opfield Landing",
      "0 resource edge-1",
      "0 resource Loose",
      "0 resource In a folder I cannot list",
    ]);
  });

  it("hangs app Docker members under their node in one app environment row", () => {
    const dockerApps: AppScopeApp[] = [
      {
        id: "app-opfield",
        name: "Opfield",
        environments: [
          { id: "env", name: "production", memberCounts: {}, folderIds: { containers: "d-env" } },
        ],
      },
    ];
    const rows = buildRestrictionRows({
      family: "docker",
      resourceOptions: [
        { id: "n1", label: "docker-1" },
        { id: "n1/web", label: "web", parentId: "n1", folderId: "d-env" },
        { id: "n1/db", label: "db", parentId: "n1" },
      ],
      folders: [],
      knownFolders: [],
      appFolders: appFolderOptions(dockerApps),
      canSelectAppFolder: () => true,
      isAppFolderChosen: () => false,
    });
    expect(summary(rows)).toEqual([
      "0 resource docker-1",
      "1 folder Opfield · production",
      "2 resource web",
      "1 resource db",
    ]);
  });
});
