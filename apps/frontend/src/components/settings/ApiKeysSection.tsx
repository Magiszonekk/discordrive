import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { prepareApiKey } from "../../lib/crypto.js";
import { authInputClass, authLabelClass } from "../layout/AuthCard.js";

const API_KEYS_QUERY = `
  query ApiKeys {
    apiKeys { id name prefix createdAt lastUsedAt expiresAt }
  }
`;

const CREATE_API_KEY_MUTATION = `
  mutation CreateApiKey($name: String!, $authPart: String!, $wrappedARKByKey: String!, $wrappedARKIv: String!) {
    createApiKey(name: $name, authPart: $authPart, wrappedARKByKey: $wrappedARKByKey, wrappedARKIv: $wrappedARKIv) {
      id
    }
  }
`;

const REVOKE_API_KEY_MUTATION = `
  mutation RevokeApiKey($apiKeyId: ID!) {
    revokeApiKey(apiKeyId: $apiKeyId)
  }
`;

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

function formatWhen(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleDateString();
}

export function ApiKeysSection() {
  const ark = useAuthStore((s) => s.ark);
  const queryClient = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  // Held only until the operator dismisses it — the server cannot reissue it.
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data } = useQuery({
    queryKey: ["apiKeys"],
    queryFn: () => gqlRequest<{ apiKeys: ApiKeyRow[] }>(API_KEYS_QUERY),
  });

  const createKey = useMutation({
    mutationFn: async (keyName: string) => {
      if (!ark) throw new Error("Account key is locked — sign in again to create an API key");
      const prepared = await prepareApiKey(ark);
      await gqlRequest(CREATE_API_KEY_MUTATION, {
        name: keyName,
        authPart: prepared.authPart,
        wrappedARKByKey: prepared.wrappedARKByKey,
        wrappedARKIv: prepared.wrappedARKIv,
      });
      return prepared.secret;
    },
    onSuccess: (secret) => {
      setFreshSecret(secret);
      setCopied(false);
      setShowForm(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    },
  });

  const revokeKey = useMutation({
    mutationFn: (apiKeyId: string) => gqlRequest(REVOKE_API_KEY_MUTATION, { apiKeyId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["apiKeys"] }),
  });

  const keys = data?.apiKeys ?? [];

  return (
    <section className="border-t border-rule pt-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="mb-1 text-lg font-semibold text-ink">API Keys</h2>
          <p className="text-sm text-muted">
            Let scripts read and write files in this account. Keys cannot change your password or read your
            account key, and the web app keeps working alongside them.
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => {
              setShowForm(true);
              setError("");
            }}
            className="h-11 shrink-0 rounded-md border border-rule-2 px-4 text-sm font-medium text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
          >
            New key
          </button>
        )}
      </div>

      {freshSecret && (
        <div className="mt-4 rounded-card border border-accent bg-accent/10 p-4">
          <p className="mb-2 text-sm font-medium text-ink">
            Copy this key now — it is shown once and cannot be recovered.
          </p>
          <p className="mb-3 text-xs text-muted">
            Half of it never reaches the server, so nobody can show it to you again. Losing it means creating a
            new key.
          </p>
          <code className="block break-all rounded-md bg-paper-2 p-3 font-mono text-xs text-ink">
            {freshSecret}
          </code>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(freshSecret).then(() => setCopied(true));
              }}
              className="h-9 rounded-md border border-rule-2 px-3 text-sm font-medium text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setFreshSecret(null)}
              className="h-9 rounded-md px-3 text-sm font-medium text-muted transition-colors duration-short ease-out hover:text-ink"
            >
              Done
            </button>
          </div>
        </div>
      )}

      <div
        className="grid transition-[grid-template-rows] duration-long ease-in-out"
        style={{ gridTemplateRows: showForm ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden" inert={!showForm}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              if (!name.trim()) {
                setError("Give the key a name so you can recognise it later");
                return;
              }
              createKey.mutate(name.trim());
            }}
            className="mt-4 space-y-4"
          >
            <div>
              <label className={authLabelClass}>Key name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="backup-script"
                className={authInputClass}
              />
            </div>
            {error && <p className="text-sm text-error">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createKey.isPending}
                className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createKey.isPending ? "Creating…" : "Create key"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setName("");
                  setError("");
                }}
                className="h-11 rounded-md px-4 text-sm font-medium text-muted transition-colors duration-short ease-out hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>

      {keys.length > 0 && (
        <ul className="mt-4 space-y-2">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex items-center justify-between gap-4 rounded-card border border-rule p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{key.name}</p>
                <p className="font-mono text-xs text-muted">
                  ddv4_{key.prefix}… · created {formatWhen(key.createdAt)} · last used{" "}
                  {formatWhen(key.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revokeKey.mutate(key.id)}
                disabled={revokeKey.isPending}
                className="h-9 shrink-0 rounded-md border border-rule-2 px-3 text-sm font-medium text-error transition-colors duration-short ease-out hover:bg-paper-2 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {keys.length === 0 && !showForm && (
        <p className="mt-4 text-sm text-muted">No API keys yet.</p>
      )}
    </section>
  );
}
