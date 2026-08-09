const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS = `${GITHUB_ISSUER}/.well-known/jwks`;
const EXPECTED_WORKFLOW =
  "ttropolis/fablepeak/.github/workflows/production-smoke.yml@refs/heads/main";

type VerificationDependencies = {
  fetcher: typeof fetch;
  now: () => number;
};

type GitHubJwk = JsonWebKey & { kid?: string; alg?: string };

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

/** Verify GitHub's short-lived identity and restrict it to the production monitor workflow. */
export async function verifyGitHubActionsRequest(
  req: Request,
  overrides: Partial<VerificationDependencies> = {},
): Promise<boolean> {
  try {
    const dependencies: VerificationDependencies = {
      fetcher: fetch,
      now: () => Date.now(),
      ...overrides,
    };
    const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJson(encodedHeader);
    const claims = decodeJson(encodedPayload);
    const nowSeconds = Math.floor(dependencies.now() / 1000);
    const audience = claims.aud;
    const audienceOk = audience === "fablepeak-operations" ||
      (Array.isArray(audience) && audience.includes("fablepeak-operations"));
    if (header.alg !== "RS256" || typeof header.kid !== "string" ||
        claims.iss !== GITHUB_ISSUER || !audienceOk ||
        claims.repository !== "ttropolis/fablepeak" || claims.ref !== "refs/heads/main" ||
        claims.workflow_ref !== EXPECTED_WORKFLOW ||
        !["schedule", "workflow_dispatch"].includes(String(claims.event_name)) ||
        typeof claims.exp !== "number" || claims.exp <= nowSeconds ||
        (typeof claims.nbf === "number" && claims.nbf > nowSeconds)) {
      return false;
    }

    const response = await dependencies.fetcher(GITHUB_JWKS, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const keys = (await response.json()).keys as GitHubJwk[] | undefined;
    const jwk = keys?.find(candidate => candidate.kid === header.kid &&
      (!candidate.alg || candidate.alg === "RS256"));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, {
      name: "RSASSA-PKCS1-v1_5", hash: "SHA-256",
    }, false, ["verify"]);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
  } catch {
    return false;
  }
}
