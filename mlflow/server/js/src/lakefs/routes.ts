import { createMLflowRoutePath } from '../common/utils/RoutingUtils';

export enum LakeFSPageId {
  lakeFsPage = 'mlflow.lakefs',
}

// following same pattern as other routes files
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- TODO(FEINF-4274)
export class LakeFSRoutePaths {
  static get lakeFsPage() {
    return createMLflowRoutePath('/lakefs');
  }
}

// following same pattern as other routes files
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- TODO(FEINF-4274)
class LakeFSRoutes {
  static get lakeFsPageRoute() {
    return LakeFSRoutePaths.lakeFsPage;
  }
}

export default LakeFSRoutes;
