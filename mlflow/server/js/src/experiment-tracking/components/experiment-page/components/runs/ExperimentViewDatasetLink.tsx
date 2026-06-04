import { Button, CopyIcon, TableIcon } from '@databricks/design-system';
import type { RunDatasetWithTags } from '../../../../types';
import { DatasetSourceTypes } from '../../../../types';
import { FormattedMessage } from 'react-intl';
import { getDatasetSourceUrl } from '../../../../utils/DatasetUtils';
import { CopyButton } from '../../../../../shared/building_blocks/CopyButton';
import { LakeFSMountButton } from '../../../LakeFSMountButton';

export interface DatasetLinkProps {
  datasetWithTags: RunDatasetWithTags;
}

export function ExperimentViewDatasetLink({ datasetWithTags }: DatasetLinkProps): JSX.Element | null {
  const { dataset } = datasetWithTags;

  if (dataset.sourceType === DatasetSourceTypes.S3) {
    const url = getDatasetSourceUrl(datasetWithTags);
    if (url) {
      return (
        <CopyButton
          componentId="codegen_mlflow_app_src_experiment-tracking_components_experiment-page_components_runs_experimentviewdatasetlink.tsx_19_2"
          icon={<CopyIcon />}
          copyText={url}
        >
          <FormattedMessage
            defaultMessage="Copy S3 URI to clipboard"
            description="Text for the S3 URI copy button in the experiment run dataset drawer"
          />
        </CopyButton>
      );
    }
  }

  if (dataset.sourceType === DatasetSourceTypes.LAKEFS) {
    const url = getDatasetSourceUrl(datasetWithTags);
    let lakefsUri: string | undefined;
    try {
      lakefsUri = JSON.parse(dataset.source).uri;
    } catch {
      lakefsUri = undefined;
    }
    return (
      <div css={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {url && (
          <Button
            componentId="mlflow.experiment.dataset.lakefs.open"
            icon={<TableIcon />}
            type="primary"
            onClick={() => {
              const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
              if (newWindow) {
                newWindow.opener = null;
              }
            }}
          >
            <FormattedMessage
              defaultMessage="Open dataset"
              description="Text for the button that opens the dataset source URL in a new tab"
            />
          </Button>
        )}
        {/* mountable only when the lakeFS source is a prefix (directory) */}
        <LakeFSMountButton uri={lakefsUri} />
      </div>
    );
  }

  if (
    dataset.sourceType === DatasetSourceTypes.HTTP ||
    dataset.sourceType === DatasetSourceTypes.EXTERNAL ||
    dataset.sourceType === DatasetSourceTypes.HUGGING_FACE
  ) {
    const url = getDatasetSourceUrl(datasetWithTags);
    if (url) {
      return (
        <Button
          componentId="codegen_mlflow_app_src_experiment-tracking_components_experiment-page_components_runs_experimentviewdatasetlink.tsx_19_1"
          icon={<TableIcon />}
          type="primary"
          onClick={() => {
            const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
            if (newWindow) {
              newWindow.opener = null;
            }
          }}
        >
          <FormattedMessage
            defaultMessage="Open dataset"
            description="Text for the button that opens the dataset source URL in a new tab"
          />
        </Button>
      );
    }
  }

  return null;
}
