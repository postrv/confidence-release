// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { collaborationPublicRoute, collaborationInternalRoute } from './profile';

test('collaboration-only deployment exposes membership, discussion and fixed dependency routes', () => {
  for (const path of ['/api/session', '/api/projects', '/api/projects/p', '/api/projects/p/update', '/api/projects/p/collaboration', '/api/projects/p/collaboration/accept-invitation', '/api/projects/p/join-requests', '/api/projects/p/hub', '/api/projects/p/hub/messages', '/api/projects/p/hub/connections', '/api/projects/p/hub/connections/c/revoke', '/api/projects/p/agent/messages', '/api/projects/p/agent/dependencies/weft/bundle']) assert.equal(collaborationPublicRoute(path), true, path);
  for (const path of ['/api/state', '/api/projects/p/review', '/api/projects/p/approve', '/api/projects/p/publish', '/api/projects/p/demo', '/api/projects/p/import', '/api/projects/p/agent/approve', '/api/projects/p/weft/api/workspaces/w/sync', '/api/projects/p/collaboration/unrecognised', '/v1/enroll']) assert.equal(collaborationPublicRoute(path), false, path);
});
test('private deployment cannot call evaluator, authoring, publication, enrollment or source broker', () => {
  for (const path of ['/internal/projects/list', '/internal/projects/create', '/internal/collaboration', '/internal/collaboration-command', '/internal/inspect-invitation', '/internal/join-requests', '/internal/request-join', '/internal/project-hub', '/internal/project-agent']) assert.equal(collaborationInternalRoute(path), true, path);
  for (const path of ['/internal/enroll', '/internal/command', '/internal/observation', '/internal/runner/git', '/internal/export', '/internal/weft-proxy', '/internal/projects/source', '/internal/projection/history']) assert.equal(collaborationInternalRoute(path), false, path);
});
