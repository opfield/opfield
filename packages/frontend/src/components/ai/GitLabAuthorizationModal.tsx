import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import type { GitLabUserCredentialStatus, GitUserCredentialStatus } from "@/types/integrations";

export function GitLabAuthorizationModal() {
  const { pendingCredentialChallenge, resolveCredentialChallenge } = useAIStore();
  const [metadata, setMetadata] = useState<
    GitLabUserCredentialStatus | GitUserCredentialStatus | null
  >(null);
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The challenge whose connector details have loaded (or failed to): the
  // dialog opens once they are in, instead of growing when they arrive.
  const [detailsChallengeId, setDetailsChallengeId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = pendingCredentialChallenge !== null;
  const activeChallenge = useRetainedDialogValue(pendingCredentialChallenge, open);
  const detailsLoading = open && detailsChallengeId !== pendingCredentialChallenge.id;

  useEffect(() => {
    const challenge = pendingCredentialChallenge;
    if (!challenge) return;
    setMetadata(null);
    setUsername("");
    setToken("");
    setError(null);

    let cancelled = false;
    const request =
      challenge.provider === "gitlab"
        ? api.getGitLabUserCredentialStatus(challenge.connectorId)
        : challenge.provider === "github" || challenge.provider === "git"
          ? api.getGitUserCredentialStatus(challenge.provider, challenge.connectorId)
          : Promise.reject(new Error(`Unsupported credential provider: ${challenge.provider}`));
    void request
      .then((status) => {
        if (cancelled) return;
        setMetadata(status);
        if (status.authorized) resolveCredentialChallenge("authorized");
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Failed to load repository authorization details"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailsChallengeId(challenge.id);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingCredentialChallenge, resolveCredentialChallenge]);

  useEffect(() => {
    if (error && !loading) inputRef.current?.focus();
  }, [error, loading]);

  const submit = async () => {
    if (!activeChallenge) return;
    const nextToken = token.trim();
    if (!nextToken || loading) return;
    setLoading(true);
    setError(null);
    try {
      const status =
        activeChallenge.provider === "gitlab"
          ? await api.authorizeGitLabUserCredential(activeChallenge.connectorId, nextToken)
          : activeChallenge.provider === "github" || activeChallenge.provider === "git"
            ? await api.authorizeGitUserCredential(
                activeChallenge.provider,
                activeChallenge.connectorId,
                { username: username.trim() || undefined, token: nextToken }
              )
            : null;
      if (!status) throw new Error(`Unsupported credential provider: ${activeChallenge.provider}`);
      setMetadata(status);
      setToken("");
      resolveCredentialChallenge("authorized");
    } catch (requestError) {
      setToken("");
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The repository provider rejected this credential"
      );
    } finally {
      setLoading(false);
    }
  };

  const reject = () => {
    if (loading) return;
    setToken("");
    resolveCredentialChallenge("rejected");
  };

  const provider = activeChallenge?.provider ?? "gitlab";
  const providerLabel = provider === "github" ? "GitHub" : provider === "git" ? "Git" : "GitLab";
  const authorizationUrl =
    metadata && "authorizationUrl" in metadata
      ? metadata.authorizationUrl
      : metadata?.patCreationUrl;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && reject()}>
      <DialogContent hideCloseButton>
        <DialogHeader>
          <DialogTitle>Authorize {providerLabel}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Opfield needs your personal repository credential for this connector. It is sent directly
          to Opfield, stored encrypted, used only for this connector, and never added to the AI
          conversation.
        </DialogDescription>

        <div className="space-y-4">
          <ConnectorDetails
            loading={detailsLoading}
            name={metadata?.connectorName ?? `${providerLabel} connector`}
            baseUrl={metadata?.baseUrl}
          />

          {provider !== "git" ? (
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>Open {providerLabel}’s personal access token page using the button below.</li>
              <li>Review the requested repository permissions and expiry.</li>
              <li>Generate the token and copy it before leaving the page.</li>
              <li>Return here and paste the token below.</li>
            </ol>
          ) : null}

          {authorizationUrl ? (
            <Button variant="outline" className="w-full" asChild>
              <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">
                Create personal access token in {providerLabel}
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          ) : null}

          {provider === "git" ? (
            <div className="space-y-1.5">
              <label htmlFor="git-personal-username" className="text-sm font-medium">
                Username
              </label>
              <Input
                id="git-personal-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                disabled={loading}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="gitlab-personal-token" className="text-sm font-medium">
              {provider === "git" ? "Access token or password" : "Personal access token"}
            </label>
            <Input
              ref={inputRef}
              id="gitlab-personal-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              autoComplete="off"
              autoFocus
              disabled={loading}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "gitlab-personal-token-error" : undefined}
            />
            {error ? (
              <p
                id="gitlab-personal-token-error"
                className="text-sm text-destructive"
                role="alert"
                aria-live="polite"
              >
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={reject} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            pending={loading}
            disabled={!token.trim() || (provider === "git" && !username.trim())}
          >
            {loading ? `Checking ${providerLabel} access…` : "Authorize"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The connector the credential is for. Reports its load, so the dialog opens complete. */
function ConnectorDetails({
  loading,
  name,
  baseUrl,
}: {
  loading: boolean;
  name: string;
  baseUrl?: string;
}) {
  useContentLoading(loading);
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      <div className="font-medium">{name}</div>
      {baseUrl ? (
        <div className="mt-1 break-all text-xs text-muted-foreground">{baseUrl}</div>
      ) : null}
    </div>
  );
}
