// DiscorDrive v4 — GraphQL client

import { GraphQLClient } from "graphql-request";
import { useAuthStore } from "../stores/auth.js";

const endpoint = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/graphql`
  : typeof window !== "undefined"
    ? `${window.location.origin}/graphql`
    : "/graphql";

export function getGraphQLClient(authToken?: string): GraphQLClient {
  const token = authToken ?? useAuthStore.getState().token;
  return new GraphQLClient(endpoint, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function gqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
  authToken?: string,
): Promise<T> {
  const client = getGraphQLClient(authToken);
  return client.request<T>(query, variables);
}

/**
 * Extract a human-readable, single-line message from a GraphQL error.
 *
 * graphql-request (v7) surfaces server failures as a ClientError whose
 * `.message` is the ENTIRE serialized HTTP response (query, variables and
 * body). Displaying it verbatim leaks transport internals and is unreadable.
 *
 * The clean message lives in `error.response.errors[].message` (and in
 * `error.response.errors[].extensions.message` as a fallback). We also defend
 * against the graphql-request v6 shape (`error.response.error`) and surface a
 * generic message for transport-level failures.
 */
export function getGraphQLErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return "Request failed";

  const err = error as {
    response?: {
      errors?: Array<{ message?: string; extensions?: { message?: string } }>;
      error?: { message?: string };
      status?: number;
      body?: unknown;
    };
    message?: string;
  };

  const gqlErrors = err?.response?.errors;
  if (Array.isArray(gqlErrors) && gqlErrors.length > 0) {
    const first = gqlErrors[0];
    const msg = first?.message ?? first?.extensions?.message;
    if (msg) return msg;
  }

  // graphql-request v6-style: error.response.error.message
  if (err?.response?.error?.message) return err.response.error.message;

  // Network / transport failure (no GraphQL response at all).
  if (err?.response?.status === undefined && typeof err?.message === "string") {
    if (/^(fetch|network|request|connect|timeout)/i.test(err.message.trim())) {
      return "Network error — could not reach the server.";
    }
  }

  if (typeof err?.message === "string") {
    // graphql-request sometimes prefixes with "GraphQL Error (Code: XXX):".
    const trimmed = err.message.trim();
    const codeMatch = trimmed.match(/^GraphQL Error \(Code: \d+\):\s*(.+)$/s);
    if (codeMatch) return codeMatch[1].trim();
    // If the message is short and clean (no JSON leakage), it is safe to show.
    if (trimmed.length <= 200 && !/\{[\s\S]*"response"[\s\S]*\}/.test(trimmed)) {
      return trimmed;
    }
  }

  return "Request failed. Please try again.";
}
