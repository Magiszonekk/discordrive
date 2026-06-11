import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@ddv4/database";
import { createYoga } from "graphql-yoga";
import { buildSchema } from "../../schema.js";

vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

const authSchema = buildSchema();
const yoga = createYoga({ schema: authSchema, graphqlEndpoint: "/graphql" });

type AuthResponseData = {
  register?: {
    token: string;
    user: {
      id: string;
      email: string;
      username: string | null;
      crypto: {
        wrappedARKByPassword: string;
        wrappedARKByRecovery: string;
        argon2Params: {
          memoryKB: number;
          iterations: number;
          parallelism: number;
          saltB64: string;
        };
        lastPasswordChangeAt: string;
      };
    };
  };
  login?: {
    token: string;
    user: {
      id: string;
      email: string;
      username: string | null;
      crypto: {
        wrappedARKByPassword: string;
        wrappedARKByRecovery: string;
        argon2Params: {
          memoryKB: number;
          iterations: number;
          parallelism: number;
          saltB64: string;
        };
        lastPasswordChangeAt: string;
      };
    };
  };
  changePassword?: boolean;
};

const baseUser = {
  email: "auth-bootstrap@example.com",
  username: "auth-bootstrap",
};

const initialServerAuthProof = Buffer.from("server-auth-proof-v1").toString("base64");
const updatedServerAuthProof = Buffer.from("server-auth-proof-v2").toString("base64");

const initialBootstrap = {
  wrappedARKByPassword: Buffer.from("ark-password-v1").toString("base64"),
  wrappedARKByRecovery: Buffer.from("ark-recovery-v1").toString("base64"),
  argon2Params: {
    memoryKB: 262144,
    iterations: 5,
    parallelism: 2,
    saltB64: Buffer.from("salt-v1").toString("base64"),
  },
  serverAuthProof: initialServerAuthProof,
};

const updatedPasswordBootstrap = {
  currentServerAuthProof: initialServerAuthProof,
  wrappedARKByPassword: Buffer.from("ark-password-v2").toString("base64"),
  argon2Params: {
    memoryKB: 131072,
    iterations: 4,
    parallelism: 1,
    saltB64: Buffer.from("salt-v2").toString("base64"),
  },
  serverAuthProof: updatedServerAuthProof,
};

async function resetAuthFixtures() {
  await db.userCrypto.deleteMany({ where: { user: { email: baseUser.email } } });
  await db.user.deleteMany({ where: { email: baseUser.email } });
}

async function execAuth(document: string, variableValues?: Record<string, unknown>, userId?: string) {
  const request = new Request("http://localhost/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId ? { authorization: `Bearer ignored-for-direct-context` } : {}),
    },
    body: JSON.stringify({ query: document, variables: variableValues }),
  });

  const response = await yoga.fetch(request, {
    auth: userId ? { userId, email: baseUser.email } : null,
  });
  const result = (await response.json()) as { data?: AuthResponseData; errors?: Array<{ message: string }> };

  expect(result.errors).toBeUndefined();
  expect(result.data).toBeDefined();
  return result as { data: AuthResponseData; errors?: undefined };
}

describe("auth bootstrap gate", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetAuthFixtures();
  });

  it("register persists and login replays the exact crypto bootstrap contract", async () => {
    const mutation = /* GraphQL */ `
      mutation RegisterAndLogin(
        $email: String!
        $username: String!
        $wrappedARKByPassword: String!
        $wrappedARKByRecovery: String!
        $argon2Params: Argon2ParamsInput!
        $serverAuthProof: String!
      ) {
        register(
          email: $email
          username: $username
          wrappedARKByPassword: $wrappedARKByPassword
          wrappedARKByRecovery: $wrappedARKByRecovery
          argon2Params: $argon2Params
          serverAuthProof: $serverAuthProof
        ) {
          token
          user {
            id
            email
            username
            crypto {
              wrappedARKByPassword
              wrappedARKByRecovery
              argon2Params {
                memoryKB
                iterations
                parallelism
                saltB64
              }
              lastPasswordChangeAt
            }
          }
        }
      }
    `;

    const registerResult = await execAuth(mutation, {
      ...baseUser,
      ...initialBootstrap,
    });

    const registeredUser = registerResult.data.register?.user;
    expect(registerResult.data.register?.token).toEqual(expect.any(String));
    expect(registeredUser).toMatchObject({
      email: baseUser.email,
      username: baseUser.username,
      crypto: {
        wrappedARKByPassword: initialBootstrap.wrappedARKByPassword,
        wrappedARKByRecovery: initialBootstrap.wrappedARKByRecovery,
        argon2Params: initialBootstrap.argon2Params,
        lastPasswordChangeAt: expect.any(String),
      },
    });

    const persisted = await db.user.findUniqueOrThrow({
      where: { email: baseUser.email },
      include: { crypto: true },
    });

    expect(Buffer.from(persisted.crypto!.wrappedARKByPassword).toString("base64")).toBe(initialBootstrap.wrappedARKByPassword);
    expect(Buffer.from(persisted.crypto!.wrappedARKByRecovery).toString("base64")).toBe(initialBootstrap.wrappedARKByRecovery);
    expect({
      memoryKB: persisted.crypto!.argon2MemoryKB,
      iterations: persisted.crypto!.argon2Iterations,
      parallelism: persisted.crypto!.argon2Parallelism,
      saltB64: persisted.crypto!.argon2SaltB64,
    }).toEqual(initialBootstrap.argon2Params);

    const loginResult = await execAuth(
      /* GraphQL */ `
        mutation Login($emailOrUsername: String!, $serverAuthProof: String!) {
          login(emailOrUsername: $emailOrUsername, serverAuthProof: $serverAuthProof) {
            token
            user {
              id
              email
              username
              crypto {
                wrappedARKByPassword
                wrappedARKByRecovery
                argon2Params {
                  memoryKB
                  iterations
                  parallelism
                  saltB64
                }
                lastPasswordChangeAt
              }
            }
          }
        }
      `,
      {
        emailOrUsername: baseUser.email,
        serverAuthProof: initialServerAuthProof,
      },
    );

    expect(loginResult.data.login).toMatchObject({
      token: expect.any(String),
      user: {
        id: registeredUser?.id,
        email: baseUser.email,
        username: baseUser.username,
        crypto: {
          wrappedARKByPassword: initialBootstrap.wrappedARKByPassword,
          wrappedARKByRecovery: initialBootstrap.wrappedARKByRecovery,
          argon2Params: initialBootstrap.argon2Params,
          lastPasswordChangeAt: registeredUser?.crypto.lastPasswordChangeAt,
        },
      },
    });
  });

  it("changePassword rotates only the password-wrapped ARK and argon2 params", async () => {
    const registerResult = await execAuth(
      /* GraphQL */ `
        mutation Register(
          $email: String!
          $username: String!
          $wrappedARKByPassword: String!
          $wrappedARKByRecovery: String!
          $argon2Params: Argon2ParamsInput!
          $serverAuthProof: String!
        ) {
          register(
            email: $email
            username: $username
            wrappedARKByPassword: $wrappedARKByPassword
            wrappedARKByRecovery: $wrappedARKByRecovery
            argon2Params: $argon2Params
            serverAuthProof: $serverAuthProof
          ) {
            user {
              id
              crypto {
                wrappedARKByPassword
                wrappedARKByRecovery
                argon2Params {
                  memoryKB
                  iterations
                  parallelism
                  saltB64
                }
                lastPasswordChangeAt
              }
            }
          }
        }
      `,
      {
        ...baseUser,
        ...initialBootstrap,
      },
    );

    const userId = registerResult.data.register!.user.id;
    const initialPasswordChangeAt = registerResult.data.register!.user.crypto.lastPasswordChangeAt;

    const changeResult = await execAuth(
      /* GraphQL */ `
        mutation ChangePassword(
          $currentServerAuthProof: String!
          $wrappedARKByPassword: String!
          $argon2Params: Argon2ParamsInput!
          $serverAuthProof: String!
        ) {
          changePassword(
            currentServerAuthProof: $currentServerAuthProof
            wrappedARKByPassword: $wrappedARKByPassword
            argon2Params: $argon2Params
            serverAuthProof: $serverAuthProof
          )
        }
      `,
      updatedPasswordBootstrap,
      userId,
    );

    expect(changeResult.data.changePassword).toBe(true);

    const loginResult = await execAuth(
      /* GraphQL */ `
        mutation Login($emailOrUsername: String!, $serverAuthProof: String!) {
          login(emailOrUsername: $emailOrUsername, serverAuthProof: $serverAuthProof) {
            user {
              crypto {
                wrappedARKByPassword
                wrappedARKByRecovery
                argon2Params {
                  memoryKB
                  iterations
                  parallelism
                  saltB64
                }
                lastPasswordChangeAt
              }
            }
          }
        }
      `,
      {
        emailOrUsername: baseUser.username,
        serverAuthProof: updatedServerAuthProof,
      },
    );

    expect(loginResult.data.login?.user.crypto.wrappedARKByPassword).toBe(updatedPasswordBootstrap.wrappedARKByPassword);
    expect(loginResult.data.login?.user.crypto.wrappedARKByRecovery).toBe(initialBootstrap.wrappedARKByRecovery);
    expect(loginResult.data.login?.user.crypto.argon2Params).toEqual(updatedPasswordBootstrap.argon2Params);
    expect(Date.parse(loginResult.data.login!.user.crypto.lastPasswordChangeAt)).toBeGreaterThanOrEqual(Date.parse(initialPasswordChangeAt));

    const persisted = await db.user.findUniqueOrThrow({
      where: { id: userId },
      include: { crypto: true },
    });

    expect(Buffer.from(persisted.crypto!.wrappedARKByPassword).toString("base64")).toBe(updatedPasswordBootstrap.wrappedARKByPassword);
    expect(Buffer.from(persisted.crypto!.wrappedARKByRecovery).toString("base64")).toBe(initialBootstrap.wrappedARKByRecovery);
    expect({
      memoryKB: persisted.crypto!.argon2MemoryKB,
      iterations: persisted.crypto!.argon2Iterations,
      parallelism: persisted.crypto!.argon2Parallelism,
      saltB64: persisted.crypto!.argon2SaltB64,
    }).toEqual(updatedPasswordBootstrap.argon2Params);
  });
});
