import { BranchIcon, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';

const LakeFSPage = () => {
  const { theme } = useDesignSystemTheme();

  return (
    <div
      css={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.md,
        padding: theme.spacing.lg,
        maxWidth: 720,
      }}
    >
      <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
        <BranchIcon css={{ fontSize: theme.typography.fontSizeXl }} />
        <Typography.Title level={2} withoutMargins>
          <FormattedMessage defaultMessage="lakeFS" description="Title for the lakeFS integration page" />
        </Typography.Title>
      </div>
      <Typography.Paragraph>
        <FormattedMessage
          defaultMessage="lakeFS brings Git-like version control to your data lake. Pin every MLflow run to the exact data commit it was trained on, so experiments stay reproducible no matter how the underlying data evolves."
          description="Description paragraph for the lakeFS integration page"
        />
      </Typography.Paragraph>
      <Typography.Paragraph>
        <FormattedMessage
          defaultMessage="Runs in this workspace are tagged with their source lakeFS repository, branch, and commit — open any run to trace it back to a byte-identical snapshot of the training data."
          description="Secondary description paragraph for the lakeFS integration page"
        />
      </Typography.Paragraph>
    </div>
  );
};

export default LakeFSPage;
