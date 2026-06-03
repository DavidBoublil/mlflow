/**
 * Helpers for rendering lakefs:// URIs in the UI.
 *
 * A lakefs://<repo>/<ref>/<path> URI identifies data, but doesn't say where the
 * lakeFS server lives. Producers that store an `endpoint` alongside the URI
 * (e.g. dataset sources) should pass it; otherwise we fall back to the default
 * local development endpoint.
 */
export const DEFAULT_LAKEFS_ENDPOINT = 'http://localhost:8000';

/**
 * Builds a lakeFS web UI object-browser URL from a lakefs:// URI.
 * Returns null if the URI is not a valid lakefs:// URI.
 */
export function getLakeFSBrowseUrl(uri?: string, endpoint?: string): string | null {
  const match = uri?.match(/^lakefs:\/\/([^/]+)\/([^/]+)\/(.*)$/);
  if (!match) {
    return null;
  }
  const [, repo, ref, path] = match;
  return `${endpoint ?? DEFAULT_LAKEFS_ENDPOINT}/repositories/${repo}/objects?ref=${encodeURIComponent(
    ref,
  )}&path=${encodeURIComponent(path)}`;
}
