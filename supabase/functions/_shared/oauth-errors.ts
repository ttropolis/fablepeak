/** Convert provider errors into safe, actionable messages for the OAuth popup. */
export function providerConnectionError(error: unknown): string {
  const raw = String((error as Error)?.message ?? error);
  if (/API access blocked/i.test(raw) && /OAuthException/i.test(raw)) {
    return "Meta has blocked API access for the FablePeak developer account. " +
      "The app owner must open Meta for Developers, complete Account confirmation, " +
      "and then try connecting again.";
  }
  return raw;
}
