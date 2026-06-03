import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { Alert, Button, Input, Spinner, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { CollapsibleSection } from '../../common/components/CollapsibleSection';
import { DatasetSourceTypes } from '../types';
import { getLakeFSBrowseUrl } from '../utils/LakeFSUtils';

/**
 * Compare-runs widget: when both compared runs have lakeFS dataset sources in
 * the same repository, show the file-level diff between the two refs — the
 * same diff lakeFS shows between commits.
 *
 * lakeFS API calls require credentials; they are asked for once and kept in
 * localStorage: entered once, reused across tabs and reloads, and cleared
 * only when lakeFS rejects them (401). Requests go through the dev-server
 * /lakefs-api proxy.
 */

const CREDS_STORAGE_KEY = 'lakefs.credentials';
const LAKEFS_API_BASE = '/lakefs-api/api/v1';

interface LakeFSCoords {
  repo: string;
  ref: string;
  path: string;
}

interface DiffEntry {
  path: string;
  path_type: string;
  type: 'added' | 'removed' | 'changed' | 'conflict' | string;
  size_bytes?: number;
}

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

const loadStoredCreds = (): { key: string; secret: string } | null => {
  try {
    const raw = localStorage.getItem(CREDS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const DIFF_TYPE_STYLES: Record<string, { label: string; color: string; background: string }> = {
  added: { label: '+ added', color: '#2e7d32', background: 'rgba(46, 125, 50, 0.1)' },
  removed: { label: '− removed', color: '#c62828', background: 'rgba(198, 40, 40, 0.1)' },
  changed: { label: '~ changed', color: '#ef6c00', background: 'rgba(239, 108, 0, 0.1)' },
  conflict: { label: '! conflict', color: '#6a1b9a', background: 'rgba(106, 27, 154, 0.1)' },
};

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
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);
  const [ordered, setOrdered] = useState<{ base: LakeFSCoords; compared: LakeFSCoords } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The diff is pairwise: only offered when exactly two runs have lakeFS sources.
  const lakeFSCoords = coords.filter(Boolean) as LakeFSCoords[];
  const [left, right] = lakeFSCoords;
  const eligible = lakeFSCoords.length === 2 && runUuids.length === 2;
  const sameRepo = eligible && left.repo === right.repo;
  const sameRef = sameRepo && left.ref === right.ref;
  // Diff scope: the shared dataset prefix when both runs use the same one.
  const prefix = eligible && left.path === right.path ? left.path : '';

  const fetchDiff = useCallback(async () => {
    if (!sameRepo || sameRef || !creds) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const auth = btoa(`${creds.key}:${creds.secret}`);
      const authHeaders = { Authorization: `Basic ${auth}` };

      // The refs-diff API is directional: it reports changes on the RIGHT ref
      // relative to the base, so diffing newer->older comes back empty. Order
      // the refs by commit time (older = base) regardless of selection order.
      const getCommitDate = async (ref: string): Promise<number | null> => {
        const res = await fetch(
          `${LAKEFS_API_BASE}/repositories/${encodeURIComponent(left.repo)}/commits/${encodeURIComponent(ref)}`,
          { headers: authHeaders },
        );
        if (!res.ok) {
          return null;
        }
        return (await res.json()).creation_date ?? null;
      };
      const [leftDate, rightDate] = await Promise.all([getCommitDate(left.ref), getCommitDate(right.ref)]);
      const swap = leftDate != null && rightDate != null && leftDate > rightDate;
      const base = swap ? right : left;
      const compared = swap ? left : right;
      setOrdered({ base, compared });

      const results: DiffEntry[] = [];
      let after = '';
      do {
        const params = new URLSearchParams({ prefix, amount: '500', after });
        const res = await fetch(
          `${LAKEFS_API_BASE}/repositories/${encodeURIComponent(base.repo)}/refs/${encodeURIComponent(
            base.ref,
          )}/diff/${encodeURIComponent(compared.ref)}?${params}`,
          { headers: authHeaders },
        );
        if (res.status === 401) {
          localStorage.removeItem(CREDS_STORAGE_KEY);
          setCreds(null);
          throw new Error('lakeFS rejected the credentials — please re-enter them.');
        }
        if (!res.ok) {
          throw new Error(`lakeFS API error: ${res.status} ${res.statusText}`);
        }
        if (!res.headers.get('content-type')?.includes('application/json')) {
          // The dev-server SPA fallback answers unknown paths with 200 + HTML:
          // it means the /lakefs-api proxy (setupProxy.js) is not active.
          throw new Error('The /lakefs-api proxy is not active — restart the JS dev server to load setupProxy.js.');
        }
        const data = await res.json();
        results.push(...(data.results ?? []));
        after = data.pagination?.has_more ? data.pagination.next_offset : '';
      } while (after);
      setDiff(results);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [sameRepo, sameRef, creds, left?.repo, left?.ref, right?.ref, prefix]);

  useEffect(() => {
    if (creds && diff === null && !loading && sameRepo && !sameRef) {
      fetchDiff();
    }
  }, [creds, diff, loading, sameRepo, sameRef, fetchDiff]);

  if (!eligible) {
    return null;
  }

  const connect = () => {
    const newCreds = { key: keyInput.trim(), secret: secretInput.trim() };
    localStorage.setItem(CREDS_STORAGE_KEY, JSON.stringify(newCreds));
    setCreds(newCreds);
    setDiff(null);
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
    if (loading) {
      return <Spinner />;
    }
    if (error) {
      return (
        <Alert
          componentId="mlflow.compare-runs.lakefs-diff.error"
          closable={false}
          type="error"
          message={error}
          action={
            <Button componentId="mlflow.compare-runs.lakefs-diff.retry" onClick={() => setDiff(null)}>
              Retry
            </Button>
          }
        />
      );
    }
    if (diff !== null && diff.length === 0) {
      return (
        <Alert
          componentId="mlflow.compare-runs.lakefs-diff.empty"
          closable={false}
          type="info"
          message={`No file differences under "${prefix || '/'}" between the two data versions.`}
        />
      );
    }
    const base = ordered?.base ?? left;
    const compared = ordered?.compared ?? right;
    return (
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
        <Typography.Hint css={{ fontFamily: 'monospace' }}>
          lakefs://{base.repo}/{base.ref.slice(0, 12)}… → {compared.ref.slice(0, 12)}…
          {prefix && ` (prefix: ${prefix})`}
        </Typography.Hint>
        <table css={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {(diff ?? []).map((entry) => {
              const style = DIFF_TYPE_STYLES[entry.type] ?? {
                label: entry.type,
                color: theme.colors.textSecondary,
                background: 'transparent',
              };
              // removed objects only exist on the base ref; everything else on the compared ref
              const browseRef = entry.type === 'removed' ? base.ref : compared.ref;
              const url = getLakeFSBrowseUrl(`lakefs://${base.repo}/${browseRef}/${entry.path}`);
              return (
                <tr key={entry.path} css={{ background: style.background }}>
                  <td
                    css={{
                      padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
                      width: 110,
                      color: style.color,
                      fontFamily: 'monospace',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {style.label}
                  </td>
                  <td css={{ padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`, fontFamily: 'monospace' }}>
                    {url ? (
                      <Typography.Link
                        componentId="mlflow.compare-runs.lakefs-diff.object-link"
                        openInNewTab
                        href={url}
                      >
                        {entry.path}
                      </Typography.Link>
                    ) : (
                      entry.path
                    )}
                  </td>
                  <td
                    css={{
                      padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
                      color: theme.colors.textSecondary,
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {entry.size_bytes != null && entry.type !== 'removed' ? `${entry.size_bytes} B` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
