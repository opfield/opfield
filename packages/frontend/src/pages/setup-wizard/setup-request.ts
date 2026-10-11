export class SetupRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "SetupRequestError";
  }
}

/** A JSON request to the first-run setup API with the setup session cookie. */
export async function setupRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  csrfToken?: string
): Promise<T> {
  const headers = new Headers(
    body === undefined ? undefined : { "Content-Type": "application/json" }
  );
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api/setup${path}`, {
    method,
    credentials: "include",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string;
    data?: T;
    message?: string;
  };
  if (!response.ok)
    throw new SetupRequestError(
      payload.message ?? "Setup request failed",
      payload.code,
      response.status
    );
  return payload.data as T;
}

/**
 * Sends one raw chunk of the export file to the setup API and reports its upload progress.
 * Resolves with the bytes the server holds after it.
 */
export function setupUploadChunk(
  offset: number,
  chunk: Blob,
  csrfToken: string,
  onProgress: (sentBytes: number) => void,
  signal?: AbortSignal
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/setup/wizard/restore/archive?offset=${offset}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onerror = () => reject(new SetupRequestError("The upload was interrupted", "NETWORK"));
    xhr.onabort = () => reject(new SetupRequestError("The upload was stopped", "ABORTED"));
    xhr.onload = () => {
      let payload: { code?: string; message?: string; data?: { uploadedBytes?: number } } = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch {
        // Fall through to the status check.
      }
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        typeof payload.data?.uploadedBytes === "number"
      ) {
        resolve(payload.data.uploadedBytes);
        return;
      }
      reject(
        new SetupRequestError(
          payload.message ?? `The upload failed (HTTP ${xhr.status})`,
          payload.code,
          xhr.status
        )
      );
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(chunk);
  });
}
