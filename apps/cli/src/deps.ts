// What the command line takes from the shared client package (one place, so the bundle stays small).
export { ApiKeyError, ServerError, decodeApiKey, getHealth, isNetworkError } from "@ddv4/metadata-client";

/** Discord over the desktop agent's HTTP/2 pool (adaptive, several connections), when Node has it. */
export async function h2FetchMaybe(): Promise<typeof fetch | null> {
  try {
    const { h2Fetch } = await import("@ddv4/metadata-client/node");
    return h2Fetch() as unknown as typeof fetch;
  } catch {
    return null;
  }
}
