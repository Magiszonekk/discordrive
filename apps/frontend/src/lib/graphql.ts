// DiscorDrive v4 — GraphQL client

import { GraphQLClient } from "graphql-request";
import { useAuthStore } from "../stores/auth.js";

const endpoint = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/graphql`
  : typeof window !== "undefined"
    ? `${window.location.origin}/graphql`
    : "/graphql";

export function getGraphQLClient(): GraphQLClient {
  const token = useAuthStore.getState().token;
  return new GraphQLClient(endpoint, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function gqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const client = getGraphQLClient();
  return client.request<T>(query, variables);
}
