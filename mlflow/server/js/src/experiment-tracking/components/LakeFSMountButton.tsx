import { useEffect, useState } from 'react';
import { Button, CheckCircleIcon, FolderBranchIcon, Tooltip } from '@databricks/design-system';
import { copyToClipboard } from '../../common/utils/copyToClipboard';
import { getLakeFSMountCommand } from '../utils/LakeFSUtils';

/**
 * Button for a lakefs:// prefix that lets a data scientist read and write this
 * exact version as ordinary local files (no full download), via a read-write
 * lakeFS/Everest mount. Clicking copies the `everest mount` command; the tooltip explains what
 * it does and shows the command to run. `subject` tunes the wording for the
 * thing being mounted (a dataset vs a model).
 *
 * Renders nothing when the URI is not a mountable prefix, so callers can drop it
 * in unconditionally next to any lakeFS source/location.
 */
export const LakeFSMountButton = ({ uri, subject = 'data' }: { uri?: string; subject?: 'data' | 'model' }) => {
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
      content={
        <div>
          <div>
            Read and write this exact {subject} version as local files (no full download) by mounting it with lakeFS.
            You can edit files locally and commit the changes back. Click to copy the command, then run it in your
            terminal:
          </div>
          <div css={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: 4 }}>{command}</div>
        </div>
      }
    >
      <Button
        componentId="mlflow.lakefs.mount.copy"
        type="primary"
        icon={copied ? <CheckCircleIcon css={{ color: '#2e7d32' }} /> : <FolderBranchIcon />}
        onClick={async () => setCopied(await copyToClipboard(command))}
      >
        {copied ? 'Command copied, run in terminal' : 'Mount as local files'}
      </Button>
    </Tooltip>
  );
};

export default LakeFSMountButton;