import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export function validateInput(input) {
  if (!keys(input, ['settlementId', 'title', 'currency', 'minorUnitDigits', 'participants', 'receipts'])
    || !word(input.settlementId) || !line(input.title, 60) || typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)
    || !Number.isInteger(input.minorUnitDigits) || input.minorUnitDigits < 0 || input.minorUnitDigits > 3
    || !Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 6
    || !Array.isArray(input.receipts) || input.receipts.length < 1 || input.receipts.length > 6
    || input.participants.length * input.receipts.length > 24) throw new Error('Provide a settlement ID, title, declared currency and minor-unit digits (0–3), two to six people, and one to six receipts with at most 24 questions.');
  const people = new Set();
  for (const person of input.participants) {
    if (!keys(person, ['id', 'label']) || !isId(person.id) || people.has(person.id) || !line(person.label, 40)) throw new Error('Each participant needs a unique lowercase UUID and a label up to 40 printable ASCII characters.');
    people.add(person.id);
  }
  const receipts = new Set();
  for (const receipt of input.receipts) {
    if (!keys(receipt, ['id', 'label', 'payerId', 'amountMinor']) || !word(receipt.id) || receipt.id.length > 24 || receipts.has(receipt.id)
      || !line(receipt.label, 80) || !people.has(receipt.payerId) || !Number.isSafeInteger(receipt.amountMinor)
      || receipt.amountMinor < 1 || receipt.amountMinor > 1000000000) throw new Error('Each receipt needs a unique ID, label, known payer UUID, and integer amountMinor from 1 to 1000000000.');
    receipts.add(receipt.id);
  }
  return structuredClone(input);
}

/** Deliberately does not infer currency scales or exchange rates. */
export function formatMinor(amount, digits) {
  if (!Number.isSafeInteger(amount) || !Number.isInteger(digits) || digits < 0 || digits > 3) throw new Error('Invalid integer amount or declared scale.');
  const sign = amount < 0 ? '-' : '', raw = String(Math.abs(amount)).padStart(digits + 1, '0');
  return sign + (digits ? `${raw.slice(0, -digits)}.${raw.slice(-digits)}` : raw);
}

export function casesFor(rawInput) {
  const input = validateInput(rawInput);
  return [...input.receipts].sort((a,b) => compare(a.id,b.id)).flatMap(receipt => [...input.participants]
    .sort((a,b) => compare(a.id,b.id)).map(person => ({ receiptId:receipt.id, participantId:person.id, key:`${receipt.id}:${person.id}` })));
}

export function requestFor(input, caseKey, attemptId) {
  const item = casesFor(input).find(item => item.key === caseKey);
  if (!item || !isId(attemptId)) throw new Error('Invalid participation request or attempt.');
  const receipt = input.receipts.find(receipt => receipt.id === item.receiptId);
  const payer = input.participants.find(person => person.id === receipt.payerId), person = input.participants.find(person => person.id === item.participantId);
  const key = `settlement-${attemptId}`;
  const prompt = `${input.title}\nReceipt ${receipt.id}: ${receipt.label}\nPaid by ${payer.label}: ${input.currency} ${formatMinor(receipt.amountMinor,input.minorUnitDigits)} (${receipt.amountMinor} minor units).\n${person.label}, did you share this expense? Shared means include you in an equal split. Paying does not imply sharing. Choose Unknown if unsure.`;
  if (prompt.length > 500) throw new Error('Receipt prompt exceeds 500 characters.');
  return { prompt, context:`Split ${hash({input,caseKey}).slice(0,20)}`,
    options:[['shared','Shared'],['excluded','Did not share'],['unknown','Unknown']].map(([value,label]) => ({value,label,style:'default'})),
    responder_scope:'direct', target_user_id:item.participantId, ttl:TTL, correlation_id:key,
    data:{input_hash:hash(input), receipt_id:item.receiptId, participant_id:item.participantId, attempt_id:attemptId}, idempotencyKey:key };
}

export function validateState(state, input) {
  const cases = casesFor(input);
  if (!keys(state, ['version','inputHash','room','credentialHash','startedAt','attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > cases.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed expenses. Restore the original input.');
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id','caseKey','createdAt','request','questionId','status','observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.caseKey !== cases[index].key || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, attempt.caseKey, attempt.id))
      || !['creating','pending','answered','expired','cancelled','invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved participation request.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (attempt.observation.checkedAt < previous) throw new Error('Observation predates its creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating','pending'].includes(attempt.status) && index !== state.attempts.length-1) throw new Error('Only the last request may have an active Question.');
  }
  return state;
}

/** Equal integer shares, then deterministic debtor-to-creditor netting. No payment is executed. */
export function calculateSettlement(rawInput, participations) {
  const input = validateInput(rawInput), cases = casesFor(input);
  if (!Array.isArray(participations) || participations.length !== cases.length) throw new Error('Every participant must answer every receipt.');
  const choices = new Map();
  for (const item of participations) {
    if (!keys(item,['receiptId','participantId','shared']) || typeof item.shared !== 'boolean'
      || !cases.some(c => c.receiptId === item.receiptId && c.participantId === item.participantId)
      || choices.has(`${item.receiptId}:${item.participantId}`)) throw new Error('Invalid, repeated or unknown participation.');
    choices.set(`${item.receiptId}:${item.participantId}`,item.shared);
  }
  const people = [...input.participants].sort((a,b) => compare(a.id,b.id));
  const balances = new Map(people.map(person => [person.id,{participantId:person.id,label:person.label,paidMinor:0,owedMinor:0,netMinor:0}]));
  const allocations = [];
  for (const receipt of [...input.receipts].sort((a,b) => compare(a.id,b.id))) {
    const beneficiaries = people.filter(person => choices.get(`${receipt.id}:${person.id}`));
    if (!beneficiaries.length) throw new Error('Every receipt needs at least one declared beneficiary.');
    const base = Math.floor(receipt.amountMinor/beneficiaries.length), remainder = receipt.amountMinor % beneficiaries.length;
    const shares = beneficiaries.map((person,index) => ({ participantId:person.id, owedMinor:base+(index<remainder?1:0) }));
    for (const share of shares) balances.get(share.participantId).owedMinor += share.owedMinor;
    balances.get(receipt.payerId).paidMinor += receipt.amountMinor;
    allocations.push({receiptId:receipt.id,payerId:receipt.payerId,amountMinor:receipt.amountMinor,shares});
  }
  for (const person of balances.values()) person.netMinor=person.paidMinor-person.owedMinor;
  const creditors=[...balances.values()].filter(p=>p.netMinor>0).map(p=>({id:p.participantId,remaining:p.netMinor}));
  const debtors=[...balances.values()].filter(p=>p.netMinor<0).map(p=>({id:p.participantId,remaining:-p.netMinor}));
  const transfers=[];let credit=0;
  for (const debtor of debtors) while(debtor.remaining>0) {
    const creditor=creditors[credit];if(!creditor)throw new Error('Unbalanced settlement.');
    const amountMinor=Math.min(debtor.remaining,creditor.remaining);
    transfers.push({from:debtor.id,to:creditor.id,amountMinor,amount:formatMinor(amountMinor,input.minorUnitDigits)});
    debtor.remaining-=amountMinor;creditor.remaining-=amountMinor;if(!creditor.remaining)credit++;
  }
  if(creditors.some(p=>p.remaining))throw new Error('Unbalanced settlement.');
  return { currency:input.currency,minorUnitDigits:input.minorUnitDigits,totalMinor:input.receipts.reduce((sum,r)=>sum+r.amountMinor,0),
    allocations,balances:[...balances.values()].map(p=>({...p,net:formatMinor(p.netMinor,input.minorUnitDigits)})),transfers,
    policy:{split:'equal_among_explicit_shared_answers',remainder:'ascending_lowercase_participant_uuid',netting:'ascending_debtor_then_creditor_uuid',paymentsExecuted:false} };
}

export function report(state,input) {
  validateState(state,input);
  const participation=casesFor(input).map(item=>{
    const attempt=state.attempts.find(a=>a.caseKey===item.key),answer=attempt?.observation?.answer;
    return {...item,status:attempt?.status==='creating'?'create_unknown':attempt?.status??'unasked',choice:answer?.value??null,
      shared:answer?.value==='shared'?true:answer?.value==='excluded'?false:null,questionId:attempt?.questionId??null,attemptId:attempt?.id??null,
      responderId:answer?.responderId??null,answeredAt:answer?.answeredAt??null,askerId:attempt?.observation?.askerId??null,observedAt:attempt?.observation?.checkedAt??null};
  });
  const known=participation.every(p=>p.shared!==null);
  const noBeneficiaryReceiptIds=known?input.receipts.filter(r=>!participation.some(p=>p.receiptId===r.id&&p.shared)).map(r=>r.id).sort(compare):[];
  const complete=known&&!noBeneficiaryReceiptIds.length;
  const active=participation.find(p=>['create_unknown','pending'].includes(p.status));
  const status=active?.status??(participation.some(p=>p.status==='unasked')?'ready':complete?'complete':'incomplete');
  return {settlementId:input.settlementId,title:input.title,inputHash:hash(input),status,participation,noBeneficiaryReceiptIds,
    settlement:complete?calculateSettlement(input,participation.map(({receiptId,participantId,shared})=>({receiptId,participantId,shared}))):null};
}

export function assertParticipantRoom(rooms,room,participantIds) {
  if(!Array.isArray(rooms)||rooms.length>1000)throw new Error('Invalid room inventory.');
  const matches=rooms.filter(r=>r?.invite_code===room),selected=matches[0];
  if(matches.length!==1||selected.type!=='standard'||selected.is_public!==false||!Array.isArray(selected.members)
    ||selected.members.length>1000||participantIds.some(id=>!selected.members.some(member=>member?.user_id===id)))throw new Error('Use a granted standard private room containing every named participant.');
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved participation evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered requests must not contain participation evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved participation request, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}
