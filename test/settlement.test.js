import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, casesFor, calculateSettlement, formatMinor, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, ROOM_CODE, PARTICIPANT, OTHER, THIRD, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/expenses.json', import.meta.url), 16384);
const simple = () => ({ ...structuredClone(example), participants: structuredClone(example.participants.slice(0,2)), receipts: [structuredClone(example.receipts[0])] });
const twoTasks = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-settlement-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.participation.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later requests; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoTasks()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'shared'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.receipt_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a receipt participation', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'shared'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'shared'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.settlement, null);
    await s.run(); assert.equal(sends(s.api), 2);
    assert.equal(s.api.questions.get(id(2)).target_user_id, OTHER);
  }
});

test('original asker, lifetime and intent remain bound across reads and across requests', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoTasks()); await s.run(); s.api.answer(id(1), 'shared'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).settlement, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'shared');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'shared'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'shared'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing resolver before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'shared');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'shared'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).settlement, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


const answers = (input, choose = () => true) => casesFor(input).map(({receiptId,participantId}) => ({receiptId,participantId,shared:choose(receiptId,participantId)}));

test('one receipt splits integer units equally with remainder assigned by canonical UUID', () => {
  const input=structuredClone(example);input.receipts=input.receipts.slice(0,1);
  const result=calculateSettlement(input,answers(input));
  assert.deepEqual(result.allocations[0].shares.map(s=>s.owedMinor),[334,334,333]);
  assert.deepEqual(result.balances.map(b=>b.netMinor),[667,-334,-333]);
  assert.deepEqual(result.transfers.map(t=>[t.from,t.to,t.amountMinor]),[[OTHER,PARTICIPANT,334],[THIRD,PARTICIPANT,333]]);
});

test('payer can be excluded from beneficiaries; one sole beneficiary bears the whole receipt', () => {
  const input=simple();
  const result=calculateSettlement(input,answers(input,(_,id)=>id===OTHER));
  assert.deepEqual(result.allocations[0].shares,[{participantId:OTHER,owedMinor:1001}]);
  assert.deepEqual(result.transfers,[{from:OTHER,to:PARTICIPANT,amountMinor:1001,amount:'10.01'}]);
});

test('each receipt is rounded separately before netting and zero balances produce no transfer', () => {
  const input=simple();input.receipts=[{...input.receipts[0],id:'a',amountMinor:1},{...input.receipts[0],id:'b',payerId:OTHER,amountMinor:1}];
  const result=calculateSettlement(input,answers(input));
  assert.deepEqual(result.balances.map(p=>[p.paidMinor,p.owedMinor,p.netMinor]),[[1,2,-1],[1,0,1]]);
  assert.equal(result.transfers[0].amountMinor,1);
  const same=simple();same.receipts[0].amountMinor=2;
  assert.deepEqual(calculateSettlement(same,answers(same,(_,id)=>id===PARTICIPANT)).transfers,[]);
});

test('canonical calculation is invariant to participant, receipt and participation array permutations', () => {
  const input=structuredClone(example),evidence=answers(input,(receipt,id)=>receipt==='supplies'||id!==OTHER);
  const expected=calculateSettlement(input,evidence);
  input.participants.reverse();input.receipts.reverse();
  assert.deepEqual(calculateSettlement(input,[...evidence].reverse()),expected);
});

test('independent per-unit allocation oracle conserves costs and clearing balances across 1890 cases', () => {
  let runs=0;
  const input=structuredClone(example);input.receipts=input.receipts.slice(0,1);
  for(let amount=1;amount<=90;amount++)for(let payer=0;payer<3;payer++)for(let mask=1;mask<8;mask++){
    input.receipts[0].amountMinor=amount;input.receipts[0].payerId=input.participants[payer].id;
    const beneficiaries=input.participants.filter((_,index)=>mask&(1<<index));
    const expected=new Map(input.participants.map(p=>[p.id,0]));
    // Independently distribute individual units in a repeating beneficiary cycle.
    for(let unit=0;unit<amount;unit++)expected.set(beneficiaries[unit%beneficiaries.length].id,expected.get(beneficiaries[unit%beneficiaries.length].id)+1);
    const result=calculateSettlement(input,answers(input,(_,id)=>beneficiaries.some(p=>p.id===id)));
    assert.equal(result.totalMinor,amount);assert.equal(result.balances.reduce((sum,b)=>sum+b.netMinor,0),0);
    for(const b of result.balances)assert.equal(b.owedMinor,expected.get(b.participantId));
    const remaining=new Map(result.balances.map(b=>[b.participantId,b.netMinor]));
    for(const transfer of result.transfers){
      assert.ok(Number.isSafeInteger(transfer.amountMinor)&&transfer.amountMinor>0);assert.notEqual(transfer.from,transfer.to);
      remaining.set(transfer.from,remaining.get(transfer.from)+transfer.amountMinor);remaining.set(transfer.to,remaining.get(transfer.to)-transfer.amountMinor);
    }
    assert.ok([...remaining.values()].every(value=>value===0));runs++;
  }
  assert.equal(runs,1890);
});

test('integer formatting respects declared zero, two and three decimal scales without floating point', () => {
  for(const [amount,digits,formatted] of [[1,0,'1'],[1,2,'0.01'],[10,2,'0.10'],[1001,2,'10.01'],[-1,3,'-0.001'],[6000000000,3,'6000000.000'],[0,2,'0.00']])assert.equal(formatMinor(amount,digits),formatted);
  assert.throws(()=>formatMinor(1.1,2));assert.throws(()=>formatMinor(1,4));
});

test('none, incomplete, unknown, duplicated and fabricated participation cannot yield transfers', () => {
  const input=simple(),valid=answers(input);
  for(const choices of [[],valid.slice(0,1),[valid[0],valid[0]],valid.map(p=>({...p,shared:false})),
    [{...valid[0],shared:null},valid[1]],[{...valid[0],shared:'yes'},valid[1]],[{...valid[0],participantId:THIRD},valid[1]],
    [{...valid[0],receiptId:'absent'},valid[1]]])assert.throws(()=>calculateSettlement(input,choices));
});

test('invalid amounts, roster, receipts and question budget fail before network', async t => {
  for(const mutate of [
    p=>{p.receipts[0].amountMinor=0;},p=>{p.receipts[0].amountMinor=-1;},p=>{p.receipts[0].amountMinor=1.5;},
    p=>{p.receipts[0].amountMinor='100';},p=>{p.receipts[0].amountMinor=1000000001;},p=>{p.receipts[0].payerId=THIRD;},
    p=>{p.receipts.push({...p.receipts[0]});},p=>{p.receipts=[];},p=>{p.receipts[0].label='a\nb';},
    p=>{p.currency='usd';},p=>{p.currency='EURO';},p=>{p.minorUnitDigits=-1;},p=>{p.minorUnitDigits=4;},
    p=>{p.participants[1].id=p.participants[0].id;},p=>{p.participants.pop();},p=>{p.extra='ignored?';},
  ]){const input=simple();mutate(input);const s=await setup(t,input);await assert.rejects(s.run());assert.equal(s.api.calls.length,0);}
  const big=structuredClone(example);big.participants=[1,2,3,4,5,6].map(n=>({id:id(100+n),label:`Person ${n}`}));
  big.receipts=Array.from({length:5},(_,n)=>({id:`r${n}`,label:'Receipt',payerId:big.participants[0].id,amountMinor:1}));
  assert.throws(()=>validateInput(big),/24/);
});

test('attributed answers yield complete settlement, while finished replay stays offline', async t => {
  const s=await setup(t,structuredClone(example));
  const result=await decide(s,['shared','shared','shared','shared','excluded','shared']);
  assert.equal(result.status,'complete');assert.deepEqual(result.settlement.transfers.map(t=>t.amountMinor),[417,166]);
  assert.deepEqual(result.participation.map(p=>p.responderId),casesFor(s.options.input).map(p=>p.participantId));
  assert.ok(result.participation.every(p=>p.askerId===ASKER&&p.questionId&&p.answeredAt));
  const before=s.api.calls.length;assert.deepEqual((await s.run()).settlement,result.settlement);assert.equal(s.api.calls.length,before);
});

test('Unknown and terminal outcomes block the entire settlement without inferred sharing or retries', async t => {
  for(const terminal of ['unknown','expired','cancelled','invalid']){
    const s=await setup(t);await s.run();
    if(terminal==='unknown')s.api.answer(id(1),'unknown');
    else if(terminal==='invalid'){s.api.answer(id(1),'shared');s.api.questions.get(id(1)).answer.responder.id=OTHER;}
    else {if(terminal==='expired')s.clock.value='2026-01-01T09:16:00.000Z';s.api.terminal(id(1),terminal);}
    const first=await s.run();assert.equal(first.settlement,null);
    const result=await decide(s,['shared']);assert.equal(result.status,'incomplete');assert.equal(result.settlement,null);
    assert.equal(result.participation[0].shared,null);const count=sends(s.api);await s.run();assert.equal(sends(s.api),count);
  }
});

test('zero beneficiaries is visible as a blocking receipt even with all answers present', async t => {
  const s=await setup(t);const result=await decide(s,['excluded','excluded']);
  assert.equal(result.status,'incomplete');assert.deepEqual(result.noBeneficiaryReceiptIds,['supplies']);assert.equal(result.settlement,null);
});

test('changed amounts, labels, participants, currency, scale and input order cannot reuse saved evidence', async t => {
  const s=await setup(t);await s.run();
  for(const mutate of [p=>{p.receipts[0].amountMinor++;},p=>{p.currency='JPY';},p=>{p.minorUnitDigits=0;},
    p=>{p.receipts[0].label='Changed receipt';},p=>{p.participants.reverse();},p=>{p.participants[0].label='Renamed';},p=>{p.settlementId='other';}]){
    const input=structuredClone(s.options.input);mutate(input);const calls=s.api.calls.length;
    await assert.rejects(s.run({input}),/changed expenses/);assert.equal(s.api.calls.length,calls);
  }
  await assert.rejects(s.run({token:'new-token'}),/another connection/);
});

test('tampered state cannot swap participants, replay Questions, change choices, or reorder observations', async t => {
  const s=await setup(t);await decide(s,['shared','shared']);const original=await s.saved();
  for(const mutate of [
    state=>{state.attempts.reverse();},state=>{state.attempts[1].questionId=state.attempts[0].questionId;},
    state=>{state.attempts[1].caseKey=state.attempts[0].caseKey;},state=>{state.attempts[1].observation.answer.responderId=PARTICIPANT;},
    state=>{state.attempts[1].request.data.participant_id=PARTICIPANT;},state=>{state.attempts[1].observation.checkedAt='2026-01-01T08:59:59.999Z';},
    state=>{state.attempts[1].observation.answer.value='excluded';},
  ]){const state=structuredClone(original);mutate(state);assert.throws(()=>validateState(state,s.options.input));}
});

test('largest supported six-receipt input remains exact with 24 bounded prompts and private output', async t => {
  const input=structuredClone(example);input.settlementId='s'.repeat(40);input.title='t'.repeat(60);
  input.participants=[1,2,4,5].map(n=>({id:id(100+n),label:'l'.repeat(40)}));
  input.receipts=Array.from({length:6},(_,n)=>({id:`r${n}${'x'.repeat(22)}`,label:'l'.repeat(80),payerId:input.participants[n%4].id,amountMinor:1000000000}));
  input.currency='XYZ';input.minorUnitDigits=3;
  const s=await setup(t,input);s.api.rooms[0].members=input.participants.map(p=>({user_id:p.id}));
  const result=await decide(s,Array(24).fill('shared'));
  assert.equal(result.status,'complete');assert.equal(result.settlement.totalMinor,6000000000);
  assert.ok(result.settlement.balances.every(p=>Number.isSafeInteger(p.netMinor)));
  assert.equal(sends(s.api),24);assert.ok([...s.api.questions.values()].every(q=>q.prompt.length<=500));
  await localReport(s.directory,input,{save:true});assert.ok((await stat(join(s.directory,'report.json'))).size<1024*1024);
});
