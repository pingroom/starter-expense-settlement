import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, localReport } from './engine.js';
import { mockApi, ROOM_CODE, id } from './mock.js';

const input = await readJson(new URL('../examples/expenses.json', import.meta.url), 16384);
for (const [name, choices] of [
  ['Shared workshop costs', ['shared','shared','shared','shared','excluded','shared']],
  ['Unknown participation', ['shared','unknown','shared','shared','excluded','shared']],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-expense-demo-'));
  const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
  const options = { client:api.client,directory,input,token:'offline-fixture-token',room:ROOM_CODE,now };
  try {
    for (const [index, choice] of choices.entries()) {
      const pending=await step(options);assert.equal(pending.settlement,null);
      api.answer(id(index+1),choice);await step(options);
    }
    const result=await localReport(directory,input,{save:true});
    assert.equal(result.status,name==='Shared workshop costs'?'complete':'incomplete');
    if(result.settlement) assert.deepEqual(result.settlement.transfers.map(t=>t.amountMinor),[417,166]);
    console.log(JSON.stringify({demo:name,transport:'real SDK with local mock; no network',status:result.status,settlement:result.settlement},null,2));
    const calls=api.calls.length;await step(options);assert.equal(api.calls.length,calls);
  } finally {await rm(directory,{recursive:true,force:true});}
}
