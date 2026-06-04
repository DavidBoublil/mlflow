import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  Alert,
  Button,
  DatabaseIcon,
  Input,
  Spinner,
  TableIcon,
  Typography,
  VisibleIcon,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { CollapsibleSection } from '../../common/components/CollapsibleSection';
import { DatasetSourceTypes } from '../types';
import { getLakeFSBrowseUrl, getLakeFSObjectViewerUrl } from '../utils/LakeFSUtils';

/**
 * Compare-runs widget: when both compared runs have lakeFS dataset sources in
 * the same repository, show the file-level diff between the two refs — a port
 * of lakeFS's own "changes" tree view: directories appear as expandable
 * prefixes that lazily crawl deeper (delimiter-based diff queries), and text
 * objects expand inline to a line-level content diff.
 *
 * lakeFS API calls require credentials; they are asked for once and kept in
 * localStorage: entered once, reused across tabs and reloads, and cleared
 * only when lakeFS rejects them (401). Requests go through the dev-server
 * /lakefs-api proxy.
 */

const CREDS_STORAGE_KEY = 'lakefs.credentials';
const LAKEFS_API_BASE = '/lakefs-api/api/v1';
const PAGE_SIZE = 100;
// Same content-diff cap as the lakeFS UI
const MAX_CONTENT_DIFF_BYTES = 120 * 1024;
const TEXT_EXTENSIONS = ['csv', 'tsv', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'md', 'py', 'sql', 'log', 'xml', 'html'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

interface LakeFSCoords {
  repo: string;
  ref: string;
  path: string;
}

interface DiffEntry {
  path: string;
  path_type: 'object' | 'common_prefix' | string;
  type: 'added' | 'removed' | 'changed' | 'conflict' | 'prefix_changed' | string;
  size_bytes?: number;
}

interface Creds {
  key: string;
  secret: string;
}

class LakeFSAuthError extends Error {}

const parseLakeFSUri = (uri?: string): LakeFSCoords | null => {
  const match = uri?.match(/^lakefs:\/\/([^/]+)\/([^/]+)\/(.*)$/);
  return match ? { repo: match[1], ref: match[2], path: match[3] } : null;
};

const extractLakeFSCoords = (datasets?: any[]): LakeFSCoords | null => {
  for (const datasetWithTags of datasets ?? []) {
    const { dataset } = datasetWithTags ?? {};
    if (dataset?.sourceType === DatasetSourceTypes.LAKEFS) {
      try {
        return parseLakeFSUri(JSON.parse(dataset.source).uri);
      } catch {
        continue;
      }
    }
  }
  return null;
};

const loadStoredCreds = (): Creds | null => {
  try {
    const raw = localStorage.getItem(CREDS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const lakeFSRequest = async (
  creds: Creds,
  path: string,
  params?: Record<string, string>,
  // object CONTENT responses are raw bytes (e.g. text/csv), everything else is JSON
  expectJson = true,
): Promise<Response> => {
  const query = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${LAKEFS_API_BASE}${path}${query}`, {
    headers: { Authorization: `Basic ${btoa(`${creds.key}:${creds.secret}`)}` },
  });
  if (res.status === 401) {
    throw new LakeFSAuthError('lakeFS rejected the credentials — please re-enter them.');
  }
  if (!res.ok) {
    throw new Error(`lakeFS API error: ${res.status} ${res.statusText}`);
  }
  if (expectJson && !res.headers.get('content-type')?.includes('application/json')) {
    // The dev-server SPA fallback answers unknown paths with 200 + HTML:
    // it means the /lakefs-api proxy (setupProxy.js) is not active.
    throw new Error('The /lakefs-api proxy is not active — restart the JS dev server to load setupProxy.js.');
  }
  return res;
};

const DIFF_TYPE_STYLES: Record<string, { label: string; color: string; background: string }> = {
  added: { label: '+', color: '#2e7d32', background: 'rgba(46, 125, 50, 0.08)' },
  removed: { label: '−', color: '#c62828', background: 'rgba(198, 40, 40, 0.08)' },
  changed: { label: '~', color: '#ef6c00', background: 'rgba(239, 108, 0, 0.08)' },
  conflict: { label: '!', color: '#6a1b9a', background: 'rgba(106, 27, 154, 0.08)' },
  prefix_changed: { label: '~', color: '#ef6c00', background: 'transparent' },
};

const formatBytes = (bytes?: number): string => {
  if (bytes == null) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// --- lakeFS-managed Iceberg tables (the ChangesTree / diffTableChanges port) ---
//
// lakeFS stores each managed table as one versioned pointer at
// _lakefs_tables/iceberg/namespaces/<ns…>/tables/<name>/metadata.json, and that
// pointer file IS the full Iceberg table metadata. So a diff entry on that path
// already maps 1:1 to a table change — added/removed/changed = created/dropped/
// modified — and the file content gives snapshot/row/schema detail.

interface IcebergTableRef {
  namespace: string[];
  name: string;
  kind: 'table' | 'view';
}

const LAKEFS_TABLE_RE = /_lakefs_tables\/iceberg\/namespaces\/(.+)\/(tables|views)\/([^/]+)\/metadata\.json$/;

const parseLakeFSTablePointer = (path: string): IcebergTableRef | null => {
  const m = path.match(LAKEFS_TABLE_RE);
  if (!m) {
    return null;
  }
  return { namespace: m[1].split('/'), name: m[3], kind: m[2] === 'views' ? 'view' : 'table' };
};

interface IcebergMeta {
  snapshotId?: number;
  rows?: number;
  addedRecords?: number;
  deletedRecords?: number;
  fields: { name: string; type: string }[];
}

const parseIcebergMeta = (text: string): IcebergMeta => {
  const meta = JSON.parse(text);
  const currentSnapshotId = meta['current-snapshot-id'];
  const snapshots: any[] = meta['snapshots'] ?? [];
  const current = snapshots.find((s) => s['snapshot-id'] === currentSnapshotId);
  const summary = current?.summary ?? {};
  const schema = (meta['schemas'] ?? []).find((s: any) => s['schema-id'] === meta['current-schema-id']);
  const num = (v: any) => (v == null ? undefined : Number(v));
  return {
    snapshotId: currentSnapshotId,
    rows: num(summary['total-records']),
    addedRecords: num(summary['added-records']),
    deletedRecords: num(summary['deleted-records']),
    fields: (schema?.fields ?? []).map((f: any) => ({ name: f.name, type: String(f.type) })),
  };
};

// --- line diff (LCS), rendered as unified hunks like lakeFS's text diff ---

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

const diffLines = (a: string[], b: string[]): DiffLine[] => {
  // Guard pathological sizes: the DP table is O(n*m)
  if (a.length * b.length > 4_000_000) {
    return [];
  }
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i++] });
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j++] });
  }
  return out;
};

/** Keep only changed lines plus CONTEXT lines around them, with gap markers. */
const toHunks = (lines: DiffLine[], context = 3): Array<DiffLine | { kind: 'gap'; text: string }> => {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.kind !== 'same') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
        keep[k] = true;
      }
    }
  });
  const out: Array<DiffLine | { kind: 'gap'; text: string }> = [];
  let skipped = 0;
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      if (skipped > 0) {
        out.push({ kind: 'gap', text: `··· ${skipped} unchanged lines ···` });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) {
    out.push({ kind: 'gap', text: `··· ${skipped} unchanged lines ···` });
  }
  return out;
};

// --- object content diff (lakeFS ObjectsDiff equivalent) ---

const ObjectContentDiff = ({
  repo,
  baseRef,
  comparedRef,
  entry,
  creds,
  onAuthError,
}: {
  repo: string;
  baseRef: string;
  comparedRef: string;
  entry: DiffEntry;
  creds: Creds;
  onAuthError: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const ext = entry.path.split('.').pop()?.toLowerCase() ?? '';
  const isImage = IMAGE_EXTENSIONS.includes(ext);
  const [lines, setLines] = useState<Array<DiffLine | { kind: 'gap'; text: string }> | null>(null);
  const [images, setImages] = useState<{ base: string | null; compared: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const needsBase = entry.type !== 'added';
  const needsCompared = entry.type !== 'removed';

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    (async () => {
      try {
        if (!TEXT_EXTENSIONS.includes(ext) && !isImage) {
          throw new Error('Content diff is only available for text and image files.');
        }
        const objectPath = (ref: string) => `/repositories/${encodeURIComponent(repo)}/refs/${encodeURIComponent(ref)}/objects`;
        const statOne = async (ref: string) => {
          const res = await lakeFSRequest(creds, `${objectPath(ref)}/stat`, { path: entry.path });
          return res.json();
        };
        const stats = await Promise.all([
          needsBase ? statOne(baseRef) : null,
          needsCompared ? statOne(comparedRef) : null,
        ]);
        if (stats.some((s) => s && s.size_bytes > MAX_CONTENT_DIFF_BYTES)) {
          throw new Error(`File too large for content diff (limit ${formatBytes(MAX_CONTENT_DIFF_BYTES)}).`);
        }

        if (isImage) {
          // render the object(s) directly, like lakeFS's ImageCardDiff
          const getUrl = async (ref: string) => {
            const res = await lakeFSRequest(creds, objectPath(ref), { path: entry.path }, false);
            const url = URL.createObjectURL(await res.blob());
            objectUrls.push(url);
            return url;
          };
          const [base, compared] = await Promise.all([
            needsBase ? getUrl(baseRef) : Promise.resolve(null),
            needsCompared ? getUrl(comparedRef) : Promise.resolve(null),
          ]);
          if (!cancelled) {
            setImages({ base, compared });
          }
        } else {
          const getText = async (ref: string) => {
            const res = await lakeFSRequest(creds, objectPath(ref), { path: entry.path }, false);
            return res.text();
          };
          const [baseText, comparedText] = await Promise.all([
            needsBase ? getText(baseRef) : Promise.resolve(''),
            needsCompared ? getText(comparedRef) : Promise.resolve(''),
          ]);
          if (!cancelled) {
            setLines(toHunks(diffLines(baseText ? baseText.split('\n') : [], comparedText ? comparedText.split('\n') : [])));
          }
        }
      } catch (e: any) {
        if (e instanceof LakeFSAuthError) {
          onAuthError();
          return;
        }
        if (!cancelled) {
          setError(e.message ?? String(e));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, baseRef, comparedRef, entry.path, entry.type, creds]);

  if (loading) {
    return <Spinner size="small" />;
  }
  if (error) {
    return <Typography.Hint>{error}</Typography.Hint>;
  }
  if (isImage) {
    const imgCard = (label: string, url: string | null, tint: string) => (
      <div css={{ flex: 1, minWidth: 0 }}>
        <Typography.Hint css={{ color: tint }}>{label}</Typography.Hint>
        {url ? (
          <img
            src={url}
            alt={`${label} ${entry.path}`}
            css={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: 320,
              border: `1px solid ${theme.colors.border}`,
              borderRadius: theme.borders.borderRadiusSm,
              background: theme.colors.backgroundSecondary,
            }}
          />
        ) : (
          <Typography.Hint>—</Typography.Hint>
        )}
      </div>
    );
    return (
      <div css={{ display: 'flex', gap: theme.spacing.md, margin: `${theme.spacing.xs}px 0`, flexWrap: 'wrap' }}>
        {needsBase && imgCard('Before', images?.base ?? null, DIFF_TYPE_STYLES['removed'].color)}
        {needsCompared && imgCard('After', images?.compared ?? null, DIFF_TYPE_STYLES['added'].color)}
      </div>
    );
  }
  return (
    <div
      css={{
        fontFamily: 'monospace',
        fontSize: theme.typography.fontSizeSm,
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.borders.borderRadiusSm,
        margin: `${theme.spacing.xs}px 0`,
        maxHeight: 360,
        overflow: 'auto',
        background: theme.colors.backgroundPrimary,
      }}
    >
      {(lines ?? []).map((line, idx) => {
        const styles =
          line.kind === 'add'
            ? { background: DIFF_TYPE_STYLES['added'].background, color: DIFF_TYPE_STYLES['added'].color, marker: '+' }
            : line.kind === 'del'
              ? {
                  background: DIFF_TYPE_STYLES['removed'].background,
                  color: DIFF_TYPE_STYLES['removed'].color,
                  marker: '−',
                }
              : line.kind === 'gap'
                ? { background: 'transparent', color: theme.colors.textSecondary, marker: '' }
                : { background: 'transparent', color: theme.colors.textPrimary, marker: ' ' };
        return (
          <div
            key={idx}
            css={{
              display: 'flex',
              whiteSpace: 'pre',
              background: styles.background,
              color: styles.color,
              padding: `0 ${theme.spacing.sm}px`,
              ...(line.kind === 'gap' && { justifyContent: 'center', fontStyle: 'italic' }),
            }}
          >
            {line.kind !== 'gap' && <span css={{ width: 16, flexShrink: 0 }}>{styles.marker}</span>}
            <span css={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.text}</span>
          </div>
        );
      })}
    </div>
  );
};

// --- diff tree (lakeFS ChangesTreeContainer/TreeItemRow equivalent) ---

const DiffEntryRow = ({
  repo,
  baseRef,
  comparedRef,
  rootPrefix,
  entry,
  depth,
  creds,
  onAuthError,
}: {
  repo: string;
  baseRef: string;
  comparedRef: string;
  rootPrefix: string;
  entry: DiffEntry;
  depth: number;
  creds: Creds;
  onAuthError: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [expanded, setExpanded] = useState(false);
  const isPrefix = entry.path_type === 'common_prefix';
  const style = DIFF_TYPE_STYLES[entry.type] ?? {
    label: '·',
    color: theme.colors.textSecondary,
    background: 'transparent',
  };
  const displayName = entry.path.slice(rootPrefix.length) || entry.path;
  // removed objects only exist on the base ref; everything else on the compared ref
  const browseRef = entry.type === 'removed' ? baseRef : comparedRef;
  // files open the single-object viewer (with the DuckDB query); prefixes open the directory browser
  const browseUrl = isPrefix
    ? getLakeFSBrowseUrl(`lakefs://${repo}/${browseRef}/${entry.path}`)
    : getLakeFSObjectViewerUrl(`lakefs://${repo}/${browseRef}/${entry.path}`);

  return (
    <>
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing.xs,
          padding: `2px ${theme.spacing.sm}px`,
          paddingLeft: theme.spacing.sm + depth * theme.spacing.lg,
          background: isPrefix ? 'transparent' : style.background,
          fontFamily: 'monospace',
          fontSize: theme.typography.fontSizeSm,
          '&:hover': { background: theme.colors.actionDefaultBackgroundHover },
        }}
      >
        {isPrefix ? (
          // directories expand via the chevron, like lakeFS's PrefixTreeEntryRow
          <span
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setExpanded(!expanded)}
            onClick={() => setExpanded(!expanded)}
            css={{ cursor: 'pointer', width: 16, flexShrink: 0, color: theme.colors.textSecondary, userSelect: 'none' }}
            title="Expand directory"
          >
            {expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span css={{ width: 16, flexShrink: 0 }} />
        )}
        <span css={{ color: style.color, width: 16, flexShrink: 0, fontWeight: 600 }}>{style.label}</span>
        <span css={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {isPrefix ? (
            <span
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setExpanded(!expanded)}
              onClick={() => setExpanded(!expanded)}
              css={{ cursor: 'pointer' }}
            >
              {displayName}
            </span>
          ) : browseUrl ? (
            <Typography.Link
              componentId="mlflow.compare-runs.lakefs-diff.object-link"
              openInNewTab
              href={browseUrl}
            >
              {displayName}
            </Typography.Link>
          ) : (
            displayName
          )}
        </span>
        {!isPrefix && (
          <Typography.Link
            componentId="mlflow.compare-runs.lakefs-diff.toggle-object-changes"
            onClick={() => setExpanded(!expanded)}
            css={{ whiteSpace: 'nowrap', fontSize: theme.typography.fontSizeSm, fontFamily: 'sans-serif' }}
          >
            {expanded ? 'Hide object changes' : 'Show object changes'}
          </Typography.Link>
        )}
        <span css={{ color: theme.colors.textSecondary, whiteSpace: 'nowrap' }}>
          {!isPrefix && entry.type !== 'removed' ? formatBytes(entry.size_bytes) : ''}
        </span>
      </div>
      {expanded &&
        (isPrefix ? (
          <DiffEntryList
            repo={repo}
            baseRef={baseRef}
            comparedRef={comparedRef}
            prefix={entry.path}
            rootPrefix={entry.path}
            depth={depth + 1}
            creds={creds}
            onAuthError={onAuthError}
          />
        ) : (
          <div css={{ paddingLeft: theme.spacing.sm + (depth + 1) * theme.spacing.lg }}>
            <ObjectContentDiff
              repo={repo}
              baseRef={baseRef}
              comparedRef={comparedRef}
              entry={entry}
              creds={creds}
              onAuthError={onAuthError}
            />
          </div>
        ))}
    </>
  );
};

const DiffEntryList = ({
  repo,
  baseRef,
  comparedRef,
  prefix,
  rootPrefix,
  depth,
  creds,
  onAuthError,
}: {
  repo: string;
  baseRef: string;
  comparedRef: string;
  prefix: string;
  rootPrefix: string;
  depth: number;
  creds: Creds;
  onAuthError: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [entries, setEntries] = useState<DiffEntry[] | null>(null);
  const [nextOffset, setNextOffset] = useState<string>('');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (after: string, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await lakeFSRequest(
          creds,
          `/repositories/${encodeURIComponent(repo)}/refs/${encodeURIComponent(baseRef)}/diff/${encodeURIComponent(
            comparedRef,
          )}`,
          // delimiter groups deeper paths into expandable common_prefix entries,
          // exactly like the lakeFS changes tree
          { prefix, delimiter: '/', amount: String(PAGE_SIZE), after },
        );
        const data = await res.json();
        setEntries((prev) => (append ? [...(prev ?? []), ...(data.results ?? [])] : (data.results ?? [])));
        setHasMore(Boolean(data.pagination?.has_more));
        setNextOffset(data.pagination?.next_offset ?? '');
      } catch (e: any) {
        if (e instanceof LakeFSAuthError) {
          onAuthError();
          return;
        }
        setError(e.message ?? String(e));
      } finally {
        setLoading(false);
      }
    },
    [repo, baseRef, comparedRef, prefix, creds, onAuthError],
  );

  useEffect(() => {
    setEntries(null);
    loadPage('', false);
  }, [loadPage]);

  if (error) {
    return (
      <div css={{ paddingLeft: theme.spacing.sm + depth * theme.spacing.lg }}>
        <Alert
          componentId="mlflow.compare-runs.lakefs-diff.tree-error"
          closable={false}
          type="error"
          message={error}
          action={
            <Button componentId="mlflow.compare-runs.lakefs-diff.tree-retry" onClick={() => loadPage('', false)}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  if (entries === null) {
    return (
      <div css={{ paddingLeft: theme.spacing.sm + depth * theme.spacing.lg, padding: theme.spacing.xs }}>
        <Spinner size="small" />
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <Typography.Hint css={{ paddingLeft: theme.spacing.sm + depth * theme.spacing.lg, padding: theme.spacing.xs }}>
        {depth > 0
          ? 'No changes under this prefix.'
          : `No file differences under "${prefix || '/'}" between the two data versions.`}
      </Typography.Hint>
    );
  }
  return (
    <div>
      {entries.map((entry) => (
        <DiffEntryRow
          key={`${entry.path}:${entry.type}`}
          repo={repo}
          baseRef={baseRef}
          comparedRef={comparedRef}
          rootPrefix={rootPrefix}
          entry={entry}
          depth={depth}
          creds={creds}
          onAuthError={onAuthError}
        />
      ))}
      {hasMore && (
        <div css={{ paddingLeft: theme.spacing.sm + depth * theme.spacing.lg, padding: theme.spacing.xs }}>
          <Button
            componentId="mlflow.compare-runs.lakefs-diff.load-more"
            size="small"
            loading={loading}
            onClick={() => loadPage(nextOffset, true)}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
};

// --- Iceberg table change detail (parsed from the two metadata.json pointers) ---

const IcebergTableDetail = ({
  repo,
  baseRef,
  comparedRef,
  table,
  changeType,
  creds,
  onAuthError,
}: {
  repo: string;
  baseRef: string;
  comparedRef: string;
  table: { ref: IcebergTableRef; path: string };
  changeType: string;
  creds: Creds;
  onAuthError: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [detail, setDetail] = useState<{ base?: IcebergMeta; compared?: IcebergMeta } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchMeta = async (ref: string) => {
      const res = await lakeFSRequest(
        creds,
        `/repositories/${encodeURIComponent(repo)}/refs/${encodeURIComponent(ref)}/objects`,
        { path: table.path },
        false,
      );
      return parseIcebergMeta(await res.text());
    };
    (async () => {
      try {
        const [base, compared] = await Promise.all([
          changeType !== 'added' ? fetchMeta(baseRef) : Promise.resolve(undefined),
          changeType !== 'removed' ? fetchMeta(comparedRef) : Promise.resolve(undefined),
        ]);
        if (!cancelled) {
          setDetail({ base, compared });
        }
      } catch (e: any) {
        if (e instanceof LakeFSAuthError) {
          onAuthError();
          return;
        }
        if (!cancelled) {
          setError(e.message ?? String(e));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, baseRef, comparedRef, table.path, changeType, creds]);

  if (loading) {
    return <Spinner size="small" />;
  }
  if (error) {
    return <Typography.Hint>{error}</Typography.Hint>;
  }

  const { base, compared } = detail ?? {};
  const snapshotLine = () => {
    if (base && compared) {
      return `snapshot ${String(base.snapshotId).slice(0, 8)}… → ${String(compared.snapshotId).slice(0, 8)}…`;
    }
    const only = compared ?? base;
    return `snapshot ${String(only?.snapshotId).slice(0, 8)}…`;
  };
  const rowLine = () => {
    if (base && compared) {
      const delta = (compared.rows ?? 0) - (base.rows ?? 0);
      const sign = delta > 0 ? `+${delta}` : `${delta}`;
      const parts = [`rows ${base.rows} → ${compared.rows} (${sign})`];
      if (compared.deletedRecords) {
        parts.push(`${compared.deletedRecords} deleted`);
      }
      return parts.join(', ');
    }
    const only = compared ?? base;
    return `rows: ${only?.rows ?? '?'}`;
  };
  const schemaLine = () => {
    if (!base || !compared) {
      return null;
    }
    const baseNames = new Set(base.fields.map((f) => f.name));
    const compNames = new Set(compared.fields.map((f) => f.name));
    const added = compared.fields.filter((f) => !baseNames.has(f.name)).map((f) => `+${f.name}:${f.type}`);
    const removed = base.fields.filter((f) => !compNames.has(f.name)).map((f) => `−${f.name}`);
    const changes = [...added, ...removed];
    return changes.length ? `schema: ${changes.join(', ')}` : 'schema: unchanged';
  };

  const lines = [snapshotLine(), rowLine(), schemaLine()].filter(Boolean) as string[];
  return (
    <div
      css={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontFamily: 'monospace',
        fontSize: theme.typography.fontSizeSm,
        color: theme.colors.textSecondary,
        padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
      }}
    >
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  );
};

// --- Iceberg tables diff (lakeFS useTablesDiff / TreePanel port) ---

const IcebergTableDiff = ({
  repo,
  baseRef,
  comparedRef,
  prefix,
  creds,
  onAuthError,
}: {
  repo: string;
  baseRef: string;
  comparedRef: string;
  prefix: string;
  creds: Creds;
  onAuthError: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [tables, setTables] = useState<{ ref: IcebergTableRef; path: string; type: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    setTables(null);
    try {
      // flat listing: every changed table pointer under the prefix, in one shot
      const found: { ref: IcebergTableRef; path: string; type: string }[] = [];
      let after = '';
      do {
        const res = await lakeFSRequest(
          creds,
          `/repositories/${encodeURIComponent(repo)}/refs/${encodeURIComponent(baseRef)}/diff/${encodeURIComponent(
            comparedRef,
          )}`,
          { prefix, amount: String(PAGE_SIZE), after },
        );
        const data = await res.json();
        for (const entry of data.results ?? []) {
          const ref = parseLakeFSTablePointer(entry.path);
          if (ref) {
            found.push({ ref, path: entry.path, type: entry.type });
          }
        }
        after = data.pagination?.has_more ? data.pagination.next_offset : '';
      } while (after);
      setTables(found);
    } catch (e: any) {
      if (e instanceof LakeFSAuthError) {
        onAuthError();
        return;
      }
      setError(e.message ?? String(e));
    }
  }, [repo, baseRef, comparedRef, prefix, creds, onAuthError]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Alert
        componentId="mlflow.compare-runs.lakefs-diff.iceberg-error"
        closable={false}
        type="error"
        message={error}
        action={
          <Button componentId="mlflow.compare-runs.lakefs-diff.iceberg-retry" onClick={load}>
            Retry
          </Button>
        }
      />
    );
  }
  // self-hide while loading or when there are no managed-table changes — the
  // Objects panel is always shown alongside, mirroring lakeFS's two-panel layout
  if (tables === null || tables.length === 0) {
    return null;
  }

  // group the flat table changes into a namespace tree, like lakeFS's Tables view
  type LeafNode = { node: 'table'; ref: IcebergTableRef; path: string; type: string };
  type NsNode = { node: 'namespace'; name: string; key: string; children: TreeNode[] };
  type TreeNode = NsNode | LeafNode;
  const buildTree = (changes: typeof tables): TreeNode[] => {
    const roots: TreeNode[] = [];
    for (const c of changes) {
      let level = roots;
      let key = '';
      for (const nsPart of c.ref.namespace) {
        key = key ? `${key}/${nsPart}` : nsPart;
        let ns = level.find((n): n is NsNode => n.node === 'namespace' && n.name === nsPart);
        if (!ns) {
          ns = { node: 'namespace', name: nsPart, key, children: [] };
          level.push(ns);
        }
        level = ns.children;
      }
      level.push({ node: 'table', ref: c.ref, path: c.path, type: c.type });
    }
    return roots;
  };

  const CHANGE_LABEL: Record<string, string> = { added: 'Added', removed: 'Removed', changed: 'Modified' };
  const ROW = (depth: number) => ({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing.xs,
    padding: `2px ${theme.spacing.sm}px`,
    paddingLeft: theme.spacing.sm + depth * theme.spacing.lg,
    fontFamily: 'monospace',
    fontSize: theme.typography.fontSizeSm,
    '&:hover': { background: theme.colors.actionDefaultBackgroundHover },
  });

  const renderNode = (n: TreeNode, depth: number): React.ReactNode => {
    if (n.node === 'namespace') {
      const open = expanded[`ns:${n.key}`] ?? true; // namespaces start expanded
      return (
        <div key={`ns:${n.key}`}>
          <div css={ROW(depth)}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => setExpanded((p) => ({ ...p, [`ns:${n.key}`]: !open }))}
              onKeyDown={(e) => e.key === 'Enter' && setExpanded((p) => ({ ...p, [`ns:${n.key}`]: !open }))}
              css={{ cursor: 'pointer', width: 14, flexShrink: 0, color: theme.colors.textSecondary, userSelect: 'none' }}
            >
              {open ? '▾' : '▸'}
            </span>
            <DatabaseIcon css={{ color: theme.colors.textSecondary }} />
            <span>{n.name}</span>
          </div>
          {open && n.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    // leaf: a table or view change
    const style = DIFF_TYPE_STYLES[n.type] ?? DIFF_TYPE_STYLES['changed'];
    const open = expanded[n.path];
    const KindIcon = n.ref.kind === 'view' ? VisibleIcon : TableIcon;
    return (
      <div key={n.path}>
        <div css={ROW(depth)}>
          <span
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((p) => ({ ...p, [n.path]: !p[n.path] }))}
            onKeyDown={(e) => e.key === 'Enter' && setExpanded((p) => ({ ...p, [n.path]: !p[n.path] }))}
            css={{ cursor: 'pointer', width: 14, flexShrink: 0, color: theme.colors.textSecondary, userSelect: 'none' }}
          >
            {open ? '▾' : '▸'}
          </span>
          <KindIcon css={{ color: style.color }} />
          <span css={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{n.ref.name}</span>
          <span css={{ color: style.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{CHANGE_LABEL[n.type] ?? n.type}</span>
        </div>
        {open && (
          <div css={{ paddingLeft: theme.spacing.sm + (depth + 1) * theme.spacing.lg }}>
            <IcebergTableDetail
              repo={repo}
              baseRef={baseRef}
              comparedRef={comparedRef}
              table={{ ref: n.ref, path: n.path }}
              changeType={n.type}
              creds={creds}
              onAuthError={onAuthError}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div css={{ border: `1px solid ${theme.colors.border}`, borderRadius: theme.borders.borderRadiusSm }}>
      <div
        css={{
          padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
          fontWeight: 600,
          color: theme.colors.textSecondary,
          borderBottom: `1px solid ${theme.colors.border}`,
        }}
      >
        Tables ({tables.length})
      </div>
      {buildTree(tables).map((n) => renderNode(n, 0))}
    </div>
  );
};

// --- top-level widget ---

export const CompareRunLakeFSDiff = ({ runUuids, runNames }: { runUuids: string[]; runNames?: string[] }) => {
  const { theme } = useDesignSystemTheme();

  const datasetsByUuid = useSelector((state: any) => state.entities.runDatasetsByUuid);
  const coords = useMemo(
    () => runUuids.map((uuid) => extractLakeFSCoords(datasetsByUuid?.[uuid])),
    [runUuids, datasetsByUuid],
  );

  const [creds, setCreds] = useState(loadStoredCreds);
  const [keyInput, setKeyInput] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [ordered, setOrdered] = useState<{ base: LakeFSCoords; compared: LakeFSCoords } | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  // The diff is pairwise: only offered when exactly two runs have lakeFS sources.
  const lakeFSCoords = coords.filter(Boolean) as LakeFSCoords[];
  const [left, right] = lakeFSCoords;
  const eligible = lakeFSCoords.length === 2 && runUuids.length === 2;
  const sameRepo = eligible && left.repo === right.repo;
  const sameRef = sameRepo && left.ref === right.ref;
  // Diff scope: the shared dataset prefix when both runs use the same one.
  const prefix = eligible && left.path === right.path ? left.path : '';

  const onAuthError = useCallback(() => {
    localStorage.removeItem(CREDS_STORAGE_KEY);
    setCreds(null);
    setOrdered(null);
    setAuthError('lakeFS rejected the credentials — please re-enter them.');
  }, []);

  // Demo affordance: drop stored credentials and return to the login widget.
  const forgetCreds = useCallback(() => {
    localStorage.removeItem(CREDS_STORAGE_KEY);
    setCreds(null);
    setOrdered(null);
    setOrderError(null);
    setAuthError(null);
    setKeyInput('');
    setSecretInput('');
  }, []);

  // The refs-diff API is directional: it reports changes on the RIGHT ref
  // relative to the base, so diffing newer->older comes back empty. Order
  // the refs by commit time (older = base) regardless of selection order.
  useEffect(() => {
    if (!creds || !sameRepo || sameRef || ordered) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const getCommitDate = async (ref: string): Promise<number | null> => {
          try {
            const res = await lakeFSRequest(
              creds,
              `/repositories/${encodeURIComponent(left.repo)}/commits/${encodeURIComponent(ref)}`,
            );
            return (await res.json()).creation_date ?? null;
          } catch (e) {
            if (e instanceof LakeFSAuthError) {
              throw e;
            }
            return null; // e.g. the ref is a branch name; fall back to selection order
          }
        };
        const [leftDate, rightDate] = await Promise.all([getCommitDate(left.ref), getCommitDate(right.ref)]);
        if (cancelled) {
          return;
        }
        const swap = leftDate != null && rightDate != null && leftDate > rightDate;
        setOrdered({ base: swap ? right : left, compared: swap ? left : right });
      } catch (e: any) {
        if (e instanceof LakeFSAuthError) {
          onAuthError();
        } else if (!cancelled) {
          setOrderError(e.message ?? String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds, sameRepo, sameRef, ordered, left?.repo, left?.ref, right?.ref]);

  if (!eligible) {
    return null;
  }

  const connect = () => {
    const newCreds = { key: keyInput.trim(), secret: secretInput.trim() };
    localStorage.setItem(CREDS_STORAGE_KEY, JSON.stringify(newCreds));
    setAuthError(null);
    setCreds(newCreds);
    setOrdered(null);
  };

  const renderBody = () => {
    if (!sameRepo) {
      return (
        <Typography.Hint>
          Runs trained on datasets from different lakeFS repositories ({left.repo} vs {right.repo}) — no diff
          available.
        </Typography.Hint>
      );
    }
    if (sameRef) {
      return (
        <Alert
          componentId="mlflow.compare-runs.lakefs-diff.same-ref"
          closable={false}
          type="info"
          message={`Both runs trained on the exact same data version (${left.ref.slice(0, 12)}…) — nothing to diff.`}
        />
      );
    }
    if (!creds) {
      return (
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm, maxWidth: 420 }}>
          {authError && (
            <Alert
              componentId="mlflow.compare-runs.lakefs-diff.auth-error"
              closable={false}
              type="error"
              message={authError}
            />
          )}
          <Typography.Hint>Enter lakeFS credentials to fetch the data diff between the two runs:</Typography.Hint>
          <Input
            componentId="mlflow.compare-runs.lakefs-diff.access-key"
            placeholder="Access key ID"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <Input
            componentId="mlflow.compare-runs.lakefs-diff.secret-key"
            placeholder="Secret access key"
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            onPressEnter={connect}
          />
          <Button
            componentId="mlflow.compare-runs.lakefs-diff.connect"
            type="primary"
            onClick={connect}
            disabled={!keyInput.trim() || !secretInput.trim()}
          >
            Connect
          </Button>
        </div>
      );
    }
    if (orderError) {
      return (
        <Alert
          componentId="mlflow.compare-runs.lakefs-diff.order-error"
          closable={false}
          type="error"
          message={orderError}
          action={
            <Button
              componentId="mlflow.compare-runs.lakefs-diff.order-retry"
              onClick={() => {
                setOrderError(null);
                setOrdered(null);
              }}
            >
              Retry
            </Button>
          }
        />
      );
    }
    if (!ordered) {
      return <Spinner />;
    }
    return (
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
        <div css={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button componentId="mlflow.compare-runs.lakefs-diff.forget-creds" size="small" onClick={forgetCreds}>
            Forget lakeFS credentials
          </Button>
        </div>
        {/* Like lakeFS: the Objects file-diff panel always, then a semantic Tables
            panel below it (only when there are managed-table changes; self-hides). */}
        <div css={{ border: `1px solid ${theme.colors.border}`, borderRadius: theme.borders.borderRadiusSm }}>
          <div
            css={{
              padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
              fontWeight: 600,
              color: theme.colors.textSecondary,
              borderBottom: `1px solid ${theme.colors.border}`,
            }}
          >
            Objects
          </div>
          <DiffEntryList
            repo={ordered.base.repo}
            baseRef={ordered.base.ref}
            comparedRef={ordered.compared.ref}
            prefix={prefix}
            rootPrefix={prefix}
            depth={0}
            creds={creds}
            onAuthError={onAuthError}
          />
        </div>
        <IcebergTableDiff
          repo={ordered.base.repo}
          baseRef={ordered.base.ref}
          comparedRef={ordered.compared.ref}
          // the Tables panel always inspects the lakeFS catalog area; scope to
          // the source's namespace when the source already points inside it
          prefix={prefix.includes('_lakefs_tables/') ? prefix : '_lakefs_tables/'}
          creds={creds}
          onAuthError={onAuthError}
        />
      </div>
    );
  };

  return (
    <CollapsibleSection title={`Data diff (lakeFS): ${runNames?.[0] ?? runUuids[0]} ⇄ ${runNames?.[1] ?? runUuids[1]}`}>
      {renderBody()}
    </CollapsibleSection>
  );
};

export default CompareRunLakeFSDiff;
