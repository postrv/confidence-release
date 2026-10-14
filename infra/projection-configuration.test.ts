// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const run = promisify(execFile), root = resolve('.');
const cli = (script:string,args:string[]) => run(process.execPath,['--import','tsx',resolve('infra',script),...args],{cwd:root,maxBuffer:65536,timeout:30000});
test('projector capability is generated separately and rejected missing, mismatched, aliased or public before any package stage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'confidence-projection-config-'));
 try {
  const secrets=join(dir,'keys');await cli('configure-pilot.ts',['keys',secrets]);
  const roles=['authority','runner','evaluator','app','projector'];
  const original=Object.fromEntries(await Promise.all(roles.map(async role=>[role,await readFile(join(secrets,role+'.secrets.json'),'utf8')])));
  const a=JSON.parse(original.authority),p=JSON.parse(original.projector);
  assert.equal(p.PROJECTOR_SERVICE_TOKEN,a.PROJECTOR_SERVICE_TOKEN);assert.equal(Object.keys(p).join(','),'PROJECTOR_SERVICE_TOKEN');
  assert.equal(new Set(['APP_SERVICE_TOKEN','RUNNER_SERVICE_TOKEN','EVALUATOR_SERVICE_TOKEN','PROJECTOR_SERVICE_TOKEN'].map(key=>a[key])).size,4);
  await assert.rejects(cli('configure-pilot.ts',['keys',secrets]));
  for(const role of roles)assert.equal(await readFile(join(secrets,role+'.secrets.json'),'utf8'),original[role]);
  const input=JSON.parse(await readFile(resolve('infra/pilot.example.json'),'utf8'));input.accountId='1'.repeat(32);input.projectionDatabase.id='11111111-1111-4111-8111-111111111111';
  Object.assign(input.app,{origin:'https://owned-projection.invalid',issuer:'https://issuer.invalid',audience:'owned-projection',jwksUrl:'https://issuer.invalid/jwks',bootstrapSubjects:['https://issuer.invalid#owned-human']});
  const inputPath=join(dir,'input.json');await writeFile(inputPath,JSON.stringify(input));
  for(const kind of ['missing','mismatch','alias','permissions'] as const){
   const config=join(dir,kind+'-config'),privateDir=join(dir,kind+'-keys');await mkdir(privateDir);
   await cli('configure-pilot.ts',['configure',inputPath,config]);
   for(const role of roles)await writeFile(join(privateDir,role+'.secrets.json'),original[role],{mode:0o600});
   const projectorPath=join(privateDir,'projector.secrets.json');
   if(kind==='missing')await rm(projectorPath);
   if(kind==='mismatch')await writeFile(projectorPath,JSON.stringify({PROJECTOR_SERVICE_TOKEN:'owned-mismatched-projector-token-000001'}));
   if(kind==='alias'){const authority=JSON.parse(original.authority);authority.PROJECTOR_SERVICE_TOKEN=authority.APP_SERVICE_TOKEN;await writeFile(join(privateDir,'authority.secrets.json'),JSON.stringify(authority));await writeFile(projectorPath,JSON.stringify({PROJECTOR_SERVICE_TOKEN:authority.APP_SERVICE_TOKEN}));}
   if(kind==='permissions')await chmod(projectorPath,0o644);
   await assert.rejects(cli('deploy-pilot.ts',[config,privateDir,'--dry-run']));
   const reports=(await readdir(config)).filter(path=>/^deployment-[0-9]+\.json$/.test(path));assert.equal(reports.length,1);
   const report=JSON.parse(await readFile(join(config,reports[0]),'utf8'));assert.equal(report.status,'FAILED');assert.deepEqual(report.stages,[]);
   assert.equal(report.reason,kind==='missing'?'PRIVATE_SECRET_FILE_MISSING':kind==='mismatch'?'PRIVATE_SERVICE_TOKEN_ASSOCIATION':kind==='alias'?'PRIVATE_SERVICE_TOKEN_SEPARATION':'PRIVATE_SECRET_FILE_PERMISSIONS');
   const generated=JSON.parse(await readFile(join(config,'projector.json'),'utf8'));assert.deepEqual(generated.secrets.required,['PROJECTOR_SERVICE_TOKEN']);assert.equal(generated.services[0].service,input.deploymentPrefix+'-authority');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
