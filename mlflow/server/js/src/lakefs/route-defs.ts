import type { DocumentTitleHandle } from '../common/utils/RoutingUtils';
import { createLazyRouteElement } from '../common/utils/RoutingUtils';
import { LakeFSPageId, LakeFSRoutePaths } from './routes';

export const getLakeFSRouteDefs = () => {
  return [
    {
      path: LakeFSRoutePaths.lakeFsPage,
      element: createLazyRouteElement(() => import('./pages/LakeFSPage')),
      pageId: LakeFSPageId.lakeFsPage,
      handle: { getPageTitle: () => 'lakeFS' } satisfies DocumentTitleHandle,
    },
  ];
};
