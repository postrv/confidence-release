// SPDX-License-Identifier: Apache-2.0
import authority from '../authority/index';
import type { AuthorityEnv } from '../authority/types';
import { serveCollaborationAuthority } from './profile';
export { ProjectAuthority, ProjectDirectory } from '../authority/index';

export default {
  async fetch(request: Request, env: AuthorityEnv): Promise<Response> {
    return serveCollaborationAuthority(request, () => authority.fetch(request, env));
  },
};
