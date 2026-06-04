import { useEffect, useState } from 'react';
import { Button, CheckCircleIcon, Tooltip, XCircleIcon } from '@databricks/design-system';
import { copyToClipboard } from '../../common/utils/copyToClipboard';
import { getLakeFSMountCommand } from '../utils/LakeFSUtils';

/**
 * "Mount" button for a lakefs:// prefix — the MLflow equivalent of lakeFS's own
 * mount affordance. The full `everest mount` command lives in a tooltip (so the
 * button stays compact); clicking copies it to the clipboard. A leading
 * indicator shows ✗ until the command has been copied, then flips to ✓.
 *
 * Renders nothing when the URI is not a mountable prefix, so callers can drop it
 * in unconditionally next to any lakeFS source/location.
 */
export const LakeFSMountButton = ({ uri }: { uri?: string }) => {
  const [copied, setCopied] = useState(false);
  const command = getLakeFSMountCommand(uri);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!command) {
    return null;
  }

  return (
    <Tooltip
      componentId="mlflow.lakefs.mount.tooltip"
      side="bottom"
      maxWidth={600}
      content={<span css={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{command}</span>}
    >
      <Button
        componentId="mlflow.lakefs.mount.copy"
        size="small"
        icon={copied ? <CheckCircleIcon css={{ color: '#2e7d32' }} /> : <XCircleIcon />}
        onClick={async () => setCopied(await copyToClipboard(command))}
      >
        {copied ? 'Mount command copied' : 'Mount'}
      </Button>
    </Tooltip>
  );
};

export default LakeFSMountButton;
