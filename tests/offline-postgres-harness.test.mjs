import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('offline PostgreSQL harness pins local Docker and cleans failed launch/log paths',()=>{
 const r=spawnSync('python3',[fileURLToPath(new URL('./offline-postgres-harness-unit.py',import.meta.url))],{encoding:'utf8'});
 assert.equal(r.status,0,r.stdout+r.stderr);
});
