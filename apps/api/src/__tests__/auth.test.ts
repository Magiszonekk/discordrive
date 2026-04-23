import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@ddv4/database";

type AuthResponse = {
  login?: {
    token: string;
    user: { id: string; email: string; username: string };
  };
  register?: {
    token: string;
    user: { id: string; email: string; username: string };
  };
  me?: {
    id: string;
    email: string;
  } | null;
};

type GraphQLErrorPayload = {
  message: string;
  extensions?: { code?: string };
};

const GQL_URL = "http://localhost:3000/graphql";
const testId = randomUUID().slice(0, 8);
const testEmail = `vitest-${testId}@example.com`;
const testUsername = `vitest_${testId}`;
const testPassword = "TestPass123!";
let authToken = "";
let createdUserId = "";

async function gql<T>(query: string, token?: string): Promise<{ data?: T; errors?: GraphQLErrorPayload[] }> {
  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
  });

  return response.json() as Promise<{ data?: T; errors?: GraphQLErrorPayload[] }>;
}

describe("Auth resolvers", () => {
  beforeAll(async () => {
    await db.user.deleteMany({
      where: {
        OR: [{ email: testEmail }, { username: testUsername }],
      },
    });
  });

  afterAll(async () => {
    await db.user.deleteMany({
      where: {
        OR: [{ email: testEmail }, { username: testUsername }],
      },
    });
  });

  it("login with invalid credentials returns domain error instead of INTERNAL_SERVER_ERROR", async () => {
    const result = await gql<AuthResponse>(`mutation { login(emailOrUsername: \"nonexistent@test.com\", password: \"wrongpass\") { token } }`);
    expect(result.data).toBeNull();
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toBe("Invalid email/username or password");
    expect(result.errors?.[0]?.extensions?.code).not.toBe("INTERNAL_SERVER_ERROR");
  });

  it("register creates a new user and returns token", async () => {
    const result = await gql<AuthResponse>(`
      mutation {
        register(
          email: \"${testEmail}\"
          username: \"${testUsername}\"
          password: \"${testPassword}\"
          kekSalt: \"aabbcc\"
          wrapIv: \"ddeeff\"
          encryptedMasterKey: \"00112233\"
        ) {
          token
          user { id email username }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    expect(result.data?.register?.token).toBeTruthy();
    expect(result.data?.register?.user.email).toBe(testEmail);
    authToken = result.data!.register!.token;
    createdUserId = result.data!.register!.user.id;
  });

  it("login returns token for registered user", async () => {
    const result = await gql<AuthResponse>(`mutation { login(emailOrUsername: \"${testEmail}\", password: \"${testPassword}\") { token user { id email username } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data?.login?.token).toBeTruthy();
    expect(result.data?.login?.user.email).toBe(testEmail);
  });

  it("me returns authenticated user data", async () => {
    const result = await gql<AuthResponse>("{ me { id email } }", authToken);
    expect(result.errors).toBeUndefined();
    expect(result.data?.me?.id).toBe(createdUserId);
    expect(result.data?.me?.email).toBe(testEmail);
  });
});
