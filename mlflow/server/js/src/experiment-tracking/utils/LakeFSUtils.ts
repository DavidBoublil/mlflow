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

/**
 * Builds a lakeFS web UI single-object viewer URL from a lakefs:// URI. The
 * viewer route (`/object`) renders the object's contents and the DuckDB query
 * panel for tabular files, unlike the directory browser (`/objects`). Returns
 * null if the URI is not a valid lakefs:// URI.
 */
export function getLakeFSObjectViewerUrl(uri?: string, endpoint?: string): string | null {
  const match = uri?.match(/^lakefs:\/\/([^/]+)\/([^/]+)\/(.*)$/);
  if (!match) {
    return null;
  }
  const [, repo, ref, path] = match;
  return `${endpoint ?? DEFAULT_LAKEFS_ENDPOINT}/repositories/${repo}/object?ref=${encodeURIComponent(
    ref,
  )}&path=${encodeURIComponent(path)}`;
}

/**
 * True when the lakefs:// URI points at a prefix (directory) rather than a
 * single object — only prefixes can be mounted. lakeFS itself uses an
 * object-vs-prefix flag from its API; in the UI we approximate: a path that
 * ends with "/" or whose final segment has no file extension is a prefix.
 */
export function isLakeFSPrefix(uri?: string): boolean {
  const match = uri?.match(/^lakefs:\/\/([^/]+)\/([^/]+)\/(.*)$/);
  if (!match) {
    return false;
  }
  const path = match[3];
  const lastSegment = path.replace(/\/$/, '').split('/').pop() ?? '';
  return path === '' || path.endsWith('/') || !lastSegment.includes('.');
}

/**
 * Builds the read-write `everest mount` command for a lakefs:// prefix. Returns
 * null if the URI is not a mountable prefix. The path is normalized to end with
 * "/" so Everest mounts the whole directory; --write-mode lets the user edit
 * files locally and commit the changes back to lakeFS.
 */
export function getLakeFSMountCommand(uri?: string): string | null {
  if (!uri || !isLakeFSPrefix(uri)) {
    return null;
  }
  const normalized = uri.endsWith('/') ? uri : `${uri}/`;
  return `everest mount "${normalized}" <local-dir> --write-mode`;
}
