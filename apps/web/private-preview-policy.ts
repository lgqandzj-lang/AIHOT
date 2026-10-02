const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Private draft mode has no proxy trust or non-loopback listening mode. */
export function assertPrivatePreviewConfiguration(host: string, api: URL, trustProxy: boolean) {
  if (!loopbackHosts.has(host) || !loopbackHosts.has(api.hostname) || trustProxy) throw new Error("Private research drafts require loopback-only servers without proxy trust");
}

/** Apply before static, HTML, single-fetch and API handling; Host/Origin cannot rebind the server. */
export function privatePreviewRequestAllowed(address: string | undefined, host: string | undefined, origin: string | undefined, forwarded: string | undefined) {
  if (!address || !loopbackAddresses.has(address) || !host || forwarded) return false;
  try {
    const target = new URL(`http://${host}`);
    if (!loopbackHosts.has(target.hostname) || target.username || target.password) return false;
    if (origin && new URL(origin).origin !== target.origin) return false;
    return true;
  } catch { return false; }
}
