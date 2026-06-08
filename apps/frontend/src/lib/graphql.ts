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
