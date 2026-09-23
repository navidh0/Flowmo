/**
 * Entry point for the stats surface.
 *
 * The default export exists so integration can lazy-load this screen:
 *
 *   const StatsPage = React.lazy(() => import('@renderer/components/stats'))
 *
 * Recharts is ~300-400kB; nothing here should be imported from a module reachable on the
 * startup path.
 */

export { StatsPage as default, StatsPage } from './StatsPage'
