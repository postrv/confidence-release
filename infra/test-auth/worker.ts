// TEST ONLY. Never deploy: production Application/auth with one diagnostic route.
import application, { type ApplicationEnv } from '../../workers/app/index';
import { authenticate } from '../../workers/shared/auth';
import { errorResponse } from '../../workers/shared/errors';
import { MAX_CONTROL_BYTES } from '../../workers/shared/objects';
const clock = Date.now.bind(Date);
let offset = 0;
Date.now = () => clock() + offset;

export default {
  async fetch(request: Request, env: ApplicationEnv): Promise<Response> {
    if (new URL(request.url).pathname === '/_test/advance-clock') { offset += 31000; return Response.json({ offset }); }
    if (new URL(request.url).pathname === '/_test/clock') return Response.json({ now: Math.floor(Date.now() / 1000) });
    if (new URL(request.url).pathname === '/_test/limits') return Response.json({ controlBytes: MAX_CONTROL_BYTES });
    if (new URL(request.url).pathname === '/_test/principal') {
      try { return Response.json(await authenticate(request, env)); }
      catch (error) { return errorResponse(error); }
    }
    return application.fetch(request, env);
  },
} satisfies ExportedHandler<ApplicationEnv>;
