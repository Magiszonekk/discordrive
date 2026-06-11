import { describe, expect, it } from "vitest";

const GQL_URL = "http://localhost:3000/graphql";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: { code?: string };
  }>;
};

async function gql<T>(query: string, token?: string): Promise<GraphQLResponse<T>> {
  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
  });

  return response.json() as Promise<GraphQLResponse<T>>;
}

describe("GraphQL health", () => {
  it("responds to introspection", async (ctx) => {
    let result: GraphQLResponse<{ __typename: string }>;
    try {
      result = await gql<{ __typename: string }>("{ __typename }");
    } catch {
      // Smoke test against a live instance — skip when no API runs locally
      ctx.skip();
      return;
    }
    expect(result.errors).toBeUndefined();
    expect(result.data?.__typename).toBe("Query");
  });
});
