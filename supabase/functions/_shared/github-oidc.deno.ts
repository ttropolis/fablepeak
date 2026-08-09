import { verifyGitHubActionsRequest } from "./github-oidc.ts";

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (actual !== expected) throw new Error(`${message}: ${actual} !== ${expected}`);
};

const b64url = (value: Uint8Array | string) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

async function signedRequest(repository = "ttropolis/fablepeak") {
  const keys = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
  const header = b64url(JSON.stringify({ alg:"RS256", kid:"test-key", typ:"JWT" }));
  const payload = b64url(JSON.stringify({
    iss:"https://token.actions.githubusercontent.com", aud:"fablepeak-operations",
    repository, ref:"refs/heads/main", event_name:"schedule",
    workflow_ref:"ttropolis/fablepeak/.github/workflows/production-smoke.yml@refs/heads/main",
    exp:1_786_255_300, nbf:1_786_255_000,
  }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey,
    new TextEncoder().encode(input));
  return {
    request: new Request("https://example.test", {
      method:"POST", headers:{ Authorization:`Bearer ${input}.${b64url(new Uint8Array(signature))}` },
    }),
    fetcher: async () => new Response(JSON.stringify({ keys:[jwk] }), {
      headers:{ "Content-Type":"application/json" },
    }),
  };
}

Deno.test("GitHub OIDC accepts only the scheduled FablePeak production workflow", async () => {
  const valid = await signedRequest();
  assertEquals(await verifyGitHubActionsRequest(valid.request, {
    fetcher: valid.fetcher, now: () => 1_786_255_165_000,
  }), true);

  const otherRepo = await signedRequest("attacker/fork");
  assertEquals(await verifyGitHubActionsRequest(otherRepo.request, {
    fetcher: otherRepo.fetcher, now: () => 1_786_255_165_000,
  }), false);
});
