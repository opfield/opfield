import type {
  CA,
  Certificate,
  CertificateStatus,
  CertificateType,
  CreateIntermediateCARequest,
  CreateRootCARequest,
  IssueCertFromCSRRequest,
  IssueCertificateRequest,
  PaginatedResponse,
  ResourceFolder,
  ResourceFolderTreeNode,
  Template,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

export type CertificateExportFormat =
  | "pem"
  | "der"
  | "pkcs12"
  | "jks"
  | "chain"
  | "fullchain"
  | "private-key"
  | "pem-bundle";

export function withPkiApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class PkiApiClient extends Base {
    // ── Certificate Authorities ───────────────────────────────────────

    async listCAs(params?: { showSystem?: boolean }): Promise<CA[]> {
      return this.request<CA[]>(`/cas${params?.showSystem ? "?showSystem=true" : ""}`);
    }

    async getCA(id: string, params?: { showSystem?: boolean }): Promise<CA> {
      return this.request<CA>(`/cas/${id}${params?.showSystem ? "?showSystem=true" : ""}`);
    }

    async createRootCA(data: CreateRootCARequest): Promise<CA> {
      return this.request<CA>("/cas", {
        method: "POST",
        body: JSON.stringify(data),
      });
    }

    async createIntermediateCA(parentId: string, data: CreateIntermediateCARequest): Promise<CA> {
      return this.request<CA>(`/cas/${parentId}/intermediate`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    }

    async updateCA(
      id: string,
      data: {
        crlDistributionUrl?: string | null;
        caIssuersUrl?: string | null;
        maxValidityDays?: number;
      }
    ): Promise<CA> {
      return this.request<CA>(`/cas/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    }

    async revokeCA(id: string, reason: string): Promise<void> {
      return this.request<void>(`/cas/${id}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
    }

    async deleteCA(id: string): Promise<void> {
      return this.request<void>(`/cas/${id}`, { method: "DELETE" });
    }

    async exportCAKey(id: string, passphrase: string): Promise<Blob> {
      const bytes = await this.requestBinary(`/cas/${id}/export-key`, {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      });
      return new Blob([bytes], { type: "application/x-pkcs12" });
    }

    // ── CA folders ────────────────────────────────────────────────────
    // A folder holds whole CA hierarchies: moving a root CA moves its intermediates.

    async listCAFolders(): Promise<ResourceFolderTreeNode[]> {
      return this.unwrapData(this.request<{ data: ResourceFolderTreeNode[] }>("/cas/folders"));
    }

    async createCAFolder(data: { name: string; parentId?: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>("/cas/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateCAFolder(id: string, data: { name: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>(`/cas/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteCAFolder(id: string): Promise<void> {
      await this.request(`/cas/folders/${id}`, { method: "DELETE" });
    }

    async reorderCAFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/cas/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    /** Moves root CAs, with their intermediates, into a folder (null = ungrouped). */
    async moveCAsToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/cas/folders/move-cas", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderCAs(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/cas/folders/reorder-cas", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    // ── Certificates ──────────────────────────────────────────────────

    async listCertificates(params?: {
      page?: number;
      limit?: number;
      search?: string;
      status?: CertificateStatus;
      type?: CertificateType;
      caId?: string;
      sortBy?: string;
      sortOrder?: string;
      showSystem?: boolean;
    }): Promise<PaginatedResponse<Certificate>> {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set("page", params.page.toString());
      if (params?.limit) searchParams.set("limit", params.limit.toString());
      if (params?.search) searchParams.set("search", params.search);
      if (params?.status) searchParams.set("status", params.status);
      if (params?.type) searchParams.set("type", params.type);
      if (params?.caId) searchParams.set("caId", params.caId);
      if (params?.sortBy) searchParams.set("sortBy", params.sortBy);
      if (params?.sortOrder) searchParams.set("sortOrder", params.sortOrder);
      if (params?.showSystem) searchParams.set("showSystem", "true");
      searchParams.set("meta", "v2");

      const query = searchParams.toString();
      return this.request<PaginatedResponse<Certificate>>(
        `/certificates${query ? `?${query}` : ""}`
      );
    }

    async getCertificate(id: string): Promise<Certificate> {
      return this.request<Certificate>(`/certificates/${id}`);
    }

    async issueCertificate(
      data: IssueCertificateRequest
    ): Promise<{ certificate: Certificate; privateKeyPem: string }> {
      return this.request(`/certificates`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    }

    async issueCertificateFromCSR(data: IssueCertFromCSRRequest): Promise<Certificate> {
      return this.request<Certificate>(`/certificates/from-csr`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    }

    async revokeCertificate(id: string, reason: string): Promise<void> {
      return this.request<void>(`/certificates/${id}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
    }

    /** A revoked or expired certificate; a revoked one stays on the CRL until it would have expired. */
    async deleteCertificate(id: string): Promise<{ keptOnCrlUntil: string | null }> {
      return this.request<{ keptOnCrlUntil: string | null }>(`/certificates/${id}`, { method: "DELETE" });
    }

    async exportCertificate(
      id: string,
      format: CertificateExportFormat,
      passphrase?: string
    ): Promise<Blob> {
      if (format === "pkcs12" && !passphrase?.trim()) {
        throw new Error("Passphrase required for PKCS#12 export");
      }
      const body: Record<string, string> = { format };
      if (passphrase) body.passphrase = passphrase;
      const bytes = await this.requestBinary(`/certificates/${id}/export`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const type =
        format === "der"
          ? "application/pkix-cert"
          : format === "pkcs12"
            ? "application/x-pkcs12"
            : format === "pem-bundle"
              ? "application/zip"
              : "application/x-pem-file";
      return new Blob([bytes], { type });
    }

    async downloadChain(id: string): Promise<Blob> {
      const bytes = await this.requestBinary(`/certificates/${id}/chain`);
      return new Blob([bytes], { type: "application/x-pem-file" });
    }

    // ── Certificate folders ───────────────────────────────────────────

    async listCertificateFolders(): Promise<ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: ResourceFolderTreeNode[] }>("/certificates/folders")
      );
    }

    async createCertificateFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>("/certificates/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateCertificateFolder(id: string, data: { name: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>(`/certificates/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteCertificateFolder(id: string): Promise<void> {
      await this.request(`/certificates/folders/${id}`, { method: "DELETE" });
    }

    async reorderCertificateFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/certificates/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async moveCertificatesToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/certificates/folders/move-certificates", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderCertificates(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/certificates/folders/reorder-certificates", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    // ── Templates ─────────────────────────────────────────────────────

    async listTemplates(): Promise<Template[]> {
      return this.request<Template[]>("/templates");
    }

    async getTemplate(id: string): Promise<Template> {
      return this.request<Template>(`/templates/${id}`);
    }

    async createTemplate(data: Partial<Template>): Promise<Template> {
      return this.request<Template>("/templates", {
        method: "POST",
        body: JSON.stringify(data),
      });
    }

    async updateTemplate(id: string, data: Partial<Template>): Promise<Template> {
      return this.request<Template>(`/templates/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    }

    async deleteTemplate(id: string): Promise<void> {
      return this.request<void>(`/templates/${id}`, { method: "DELETE" });
    }

    // ── Template folders ──────────────────────────────────────────────

    async listPkiTemplateFolders(): Promise<ResourceFolderTreeNode[]> {
      return this.unwrapData(
        this.request<{ data: ResourceFolderTreeNode[] }>("/templates/folders")
      );
    }

    async createPkiTemplateFolder(data: {
      name: string;
      parentId?: string;
    }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>("/templates/folders", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updatePkiTemplateFolder(id: string, data: { name: string }): Promise<ResourceFolder> {
      return this.unwrapData(
        this.request<{ data: ResourceFolder }>(`/templates/folders/${id}`, {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async deletePkiTemplateFolder(id: string): Promise<void> {
      await this.request(`/templates/folders/${id}`, { method: "DELETE" });
    }

    async reorderPkiTemplateFolders(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/templates/folders/reorder", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }

    async movePkiTemplatesToFolder(ids: string[], folderId: string | null): Promise<void> {
      await this.request("/templates/folders/move-templates", {
        method: "POST",
        body: JSON.stringify({ ids, folderId }),
      });
    }

    async reorderPkiTemplates(items: { id: string; sortOrder: number }[]): Promise<void> {
      await this.request("/templates/folders/reorder-templates", {
        method: "PUT",
        body: JSON.stringify({ items }),
      });
    }
  };
}
