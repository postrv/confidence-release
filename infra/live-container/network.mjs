// SPDX-License-Identifier: Apache-2.0
const get=(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(2500)});
const allowed=await get('http://fixture.confidence.invalid/value',{headers:{'x-controller-generation':'forged','x-controller-scope':'forged','authorization':'Bearer forged-inert-test'}});
const identity=await allowed.json();
const denied=await get('http://denied.confidence.invalid/value');
const redirect=await get('http://fixture.confidence.invalid/redirect');
let otherPortBlocked=false;
try { const other=await get('http://denied.confidence.invalid:8443/value'); otherPortBlocked=!other.ok; } catch { otherPortBlocked=true; }
process.stdout.write(JSON.stringify({allowed:allowed.status,controllerGeneration:identity.controllerGeneration,forgedHeadersIgnored:identity.forgedHeadersIgnored,denied:denied.status,redirectDenied:redirect.status,otherPortBlocked}));
