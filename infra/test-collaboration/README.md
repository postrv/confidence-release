# Local verified collaboration rehearsal

This test-only environment runs the production Application Worker, JWT verifier,
and SQLite Durable Object in local workerd. Its issuer and four human identities
are synthetic. Never deploy the wrapper, its configuration, or the demo server.

Build and start from the repository root:

```sh
npm run build:web
node --import tsx infra/collaboration-demo.ts
```

Open the printed loopback URL, normally `http://127.0.0.1:8791/_demo`. If that
port is occupied, the server selects the next available port through 8801.
Choose Owner, select the native release project and enable verified ownership in
Project access. Invite the exact
Contributor, Reviewer, or Successor principal ID shown on the chooser, copy the
private invitation link, choose its intended person, then open the link. Review
the authority-confirmed role before accepting. Ownership promotion also requires
the recipient's acceptance; the final active human owner cannot be removed.

To begin with an owner, contributor and reviewer already admitted through the
production invitation routes:

```sh
node --import tsx infra/collaboration-demo.ts --ready-demo
```

Use separate browser profiles or contexts for simultaneous people: tabs in one
profile share cookies. Returning to `/_demo` switches the current test person.
Selecting a person issues a new signed test token. Existing tokens become too
old for sensitive management after 15 minutes; selecting the person again is a
test-token renewal, not proof of real human reauthentication.

The chooser keeps opaque, HttpOnly, SameSite=Strict cookies and signed JWTs in
server memory. It never puts JWTs or role overrides into frontend code. It only
listens on 127.0.0.1, requires the exact local Host, and requires same-origin POST
for persona selection. Browser authentication headers are discarded. Browser
requests to test-control and internal-authority paths are denied. Invitation
delivery secrets remain in URL fragments until the frontend removes them, then
only in page memory. The loopback HTTP cookie is not a production TLS session.

Stop with Ctrl-C. Session state, local authority persistence and signing keys
are removed on normal shutdown. The next run starts a new fixture. Synthetic
JWKS and repository/evaluation fixtures do not establish live Cloudflare Access,
real human ownership, external delivery, model execution or deployed security.

The full production-path checks and typechecks are:

```sh
npm run test:collaboration
```

The runtime suite exercises project-scoped collaboration and catalog access,
separate reviewer approval, grant/session revocation and private draft isolation.
The migration suite checks legacy membership suspension and preserves finalized
and already-admitted publication history. Both use synthetic owned fixtures;
they do not authorize migration of the live pilot.
