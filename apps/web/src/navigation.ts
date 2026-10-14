export type View = 'workspace' | 'review' | 'evidence' | 'timeline' | 'verify' | 'integration' | 'settings' | 'collaboration' | 'accept' | 'discussion';
export type AppView = View | 'projects';
export interface AppRoute { view: AppView; projectId?: string }
export interface NavigationState { route: AppRoute; notice: string }
export type NavigationAction = { type: 'route'; route: AppRoute } | { type: 'notice'; notice: string };

/** Old deep links remain usable without exposing workflows absent from this deployment. */
export function collaborationRoute(route: AppRoute, defaultProjectId?: string): AppRoute {
  if (['projects', 'discussion', 'collaboration', 'settings', 'accept'].includes(route.view)) return route;
  const projectId = route.projectId ?? defaultProjectId;
  return projectId ? { view: 'discussion', projectId } : { view: 'projects' };
}

export function navigationReducer(state: NavigationState, action: NavigationAction): NavigationState {
  if (action.type === 'notice') return { ...state, notice: action.notice };
  const changed = state.route.view !== action.route.view || state.route.projectId !== action.route.projectId;
  return { route: action.route, notice: changed ? '' : state.notice };
}

const routes: Record<View, string> = {
  workspace: '#/workspace', review: '#/review', evidence: '#/evidence',
  timeline: '#/history', verify: '#/verify', integration: '#/runtime', settings: '#/settings',
  collaboration: '#/collaboration', accept: '#/accept', discussion: '#/discussion',
};

export function validProjectId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }

export function routeFromHash(hash: string): AppRoute {
  if (hash === '#/projects' || hash === '' || hash === '#/' || hash === '#') return { view: 'projects' };
  const scoped = /^#\/projects\/([^/]+)\/([^/?#]+)$/.exec(hash);
  if (scoped) {
    let projectId: string;
    try { projectId = decodeURIComponent(scoped[1]); } catch { return { view: 'projects' }; }
    const view = Object.entries(routes).find(([, route]) => route === `#/${scoped[2]}`)?.[0] as View | undefined;
    if (validProjectId(projectId) && view) return { view, projectId };
    return { view: 'projects' };
  }
  if (hash.startsWith('#/projects')) return { view: 'projects' };
  return { view: viewFromHash(hash) };
}

export function viewFromHash(hash: string): View {
  return (Object.entries(routes).find(([, route]) => route === hash)?.[0] as View | undefined) ?? 'workspace';
}

export function routeForView(view: AppView, projectId?: string): string {
  if (view === 'projects') return '#/projects';
  if (projectId === undefined) return routes[view];
  if (!validProjectId(projectId)) throw new Error('Invalid project ID.');
  return `#/projects/${encodeURIComponent(projectId)}/${routes[view].slice(2)}`;
}
