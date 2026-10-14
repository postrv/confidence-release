// SPDX-License-Identifier: Apache-2.0
import application, { type ApplicationEnv } from '../app/index';
import { serveCollaborationApp } from './profile';

export default {
  fetch(request: Request, env: ApplicationEnv): Promise<Response> | Response {
    return serveCollaborationApp(request, env.MAINTENANCE_MODE === 'true', () => application.fetch(request, env));
  },
};
