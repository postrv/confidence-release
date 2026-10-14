import type { ProjectDirectoryResponse } from '../../../packages/project-model/src/types';
import { routeFromHash, validProjectId, type AppRoute } from './navigation';

export const DISCARD_SETTINGS_MESSAGE = 'You have unsaved project settings or check changes. Discard those changes and leave this page?';
export const DISCARD_DISCUSSION_MESSAGE = 'You have unsent discussion text, an unconfirmed request, or an undownloaded agent connection file. Leaving discards this page\'s recovery state. Leave this page?';

/** A draft never grants permission to retain a previous account or project incarnation. */
export function settingsDraftScope(directory: ProjectDirectoryResponse | undefined, route: AppRoute): string | undefined {
  if (!directory || route.view !== 'settings') return undefined;
  const project = directory.projects.find(item => item.projectId === (route.projectId ?? directory.defaultProjectId));
  return project ? JSON.stringify([directory.tenantId, project.projectId, project.projectIncarnation, directory.principalId]) : undefined;
}

export function protectedDraftScope(directory: ProjectDirectoryResponse | undefined, route: AppRoute): string | undefined {
  if (route.view !== 'discussion') return settingsDraftScope(directory, route);
  const projectId = route.projectId ?? directory?.defaultProjectId;
  if (!directory || !validProjectId(projectId)) return undefined;
  const project = directory.projects.find(item => item.projectId === projectId);
  return JSON.stringify(['project-discussion-v1', directory.tenantId, projectId, project?.projectIncarnation ?? 'pending-membership', directory.principalId]);
}

export function createUnsavedChanges() {
  let draft: { scope: string; dirty: boolean } | undefined;
  return {
    register(scope: string, dirty: boolean): () => void {
      const registered = { scope, dirty }; draft = registered;
      return () => { if (draft === registered) draft = undefined; };
    },
    hasChanges(scope: string | undefined): boolean { return Boolean(scope && draft?.scope === scope && draft.dirty); },
  };
}

interface HistoryPosition { session: string; index: number }
const HISTORY_KEY = 'confidenceSettingsNavigation';
function position(state: unknown): HistoryPosition | undefined {
  const value = state && typeof state === 'object' && HISTORY_KEY in state ? (state as Record<string, unknown>)[HISTORY_KEY] as Partial<HistoryPosition> : undefined;
  return value && typeof value.session === 'string' && Number.isSafeInteger(value.index) ? value as HistoryPosition : undefined;
}
function tagged(state: unknown, value: HistoryPosition) { return { ...(state && typeof state === 'object' ? state : {}), [HISTORY_KEY]: value }; }
const sameRoute = (left: AppRoute, right: AppRoute) => left.view === right.view && left.projectId === right.projectId;

export interface NavigationBrowser {
  location: Pick<Location, 'hash'>;
  history: Pick<History, 'state' | 'pushState' | 'replaceState' | 'go'>;
  addEventListener(type: 'hashchange' | 'popstate' | 'beforeunload', listener: EventListener): void;
  removeEventListener(type: 'hashchange' | 'popstate' | 'beforeunload', listener: EventListener): void;
}

/** Keep a cancelled Back/Forward visit on its original history entry and retain the mounted editor. */
export function createGuardedNavigation(browser: NavigationBrowser, options: {
  canLeave: (route: AppRoute) => boolean;
  hasChanges: (route: AppRoute) => boolean;
  changed: (route: AppRoute) => void;
  sessionId: string;
}) {
  let currentHash = browser.location.hash || '#/projects', current = routeFromHash(currentHash);
  let currentPosition = position(browser.history.state) ?? { session: options.sessionId, index: 0 };
  let restoring = false;
  const accept = (hash: string, nextPosition: HistoryPosition) => {
    currentHash = hash; current = routeFromHash(hash); currentPosition = nextPosition; options.changed(current);
  };
  const follow: EventListener = () => {
    const hash = browser.location.hash, nextPosition = position(browser.history.state);
    if (restoring) { if (hash === currentHash) restoring = false; return; }
    if (hash === currentHash) return;
    if (!sameRoute(current, routeFromHash(hash)) && !options.canLeave(current)) {
      if (nextPosition?.session === currentPosition.session && nextPosition.index !== currentPosition.index) {
        restoring = true; browser.history.go(currentPosition.index - nextPosition.index);
      } else {
        // External hash edits and history from before this app session have no usable offset.
        browser.history.replaceState(tagged(browser.history.state, currentPosition), '', currentHash || '#/projects');
      }
      return;
    }
    const next = nextPosition?.session === currentPosition.session ? nextPosition : { ...currentPosition, index: currentPosition.index + 1 };
    browser.history.replaceState(tagged(browser.history.state, next), '', hash || '#/projects');
    accept(hash, next);
  };
  const beforeUnload: EventListener = event => {
    if (!options.hasChanges(current)) return;
    event.preventDefault(); (event as BeforeUnloadEvent).returnValue = '';
  };
  return {
    navigate(hash: string): boolean {
      if (restoring) return false;
      if (hash === currentHash) return true;
      if (!sameRoute(current, routeFromHash(hash)) && !options.canLeave(current)) return false;
      const next = { ...currentPosition, index: currentPosition.index + 1 };
      browser.history.pushState(tagged(browser.history.state, next), '', hash);
      accept(hash, next); return true;
    },
    listen(): () => void {
      browser.history.replaceState(tagged(browser.history.state, currentPosition), '', currentHash || '#/projects');
      browser.addEventListener('hashchange', follow); browser.addEventListener('popstate', follow); browser.addEventListener('beforeunload', beforeUnload);
      return () => { browser.removeEventListener('hashchange', follow); browser.removeEventListener('popstate', follow); browser.removeEventListener('beforeunload', beforeUnload); };
    },
  };
}
