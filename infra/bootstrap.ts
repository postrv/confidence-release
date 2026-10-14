// SPDX-License-Identifier: Apache-2.0
// Initial deployment only: creates private service target names before the
// circular authority/runner/evaluator service bindings can be installed.
export default { fetch(): Response { return Response.json({ error: { code: 'SETUP_INCOMPLETE' } }, { status: 503, headers: { 'cache-control': 'no-store' } }); } };
