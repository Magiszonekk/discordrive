// DiscorDrive v4 — GraphQL client

import { GraphQLClient } from "graphql-request";
import { useAuthStore } from "../stores/auth.js";

const endpoint = `${window.location.origin}/graphql`;

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
