// OFFLINE CONTRACT ONLY. This module cannot contact D1, install a write fence,
// authenticate production observations, deploy a Worker, or resume live writes.
// Its durable store is a separate synthetic local SQLite database, not an
// application migration. No production route or command imports this module.
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {realpathSync, statSync} from 'node:fs';
import {relative, isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {captureLocalRollbackSnapshot, IMPORT_DELETE_COMPATIBILITY} from './manual-summary-rollback.mjs';
import {inspectManualSummaryImportSchema} from './manual-summary-migration.mjs';

export const productionExecutionSupported = false;
export const operationalEvidenceMaxAgeMs = 300_000;
export const requiredOperationalWriterClasses = Object.freeze([
 'HTTP_MUTATIONS', 'READ_PATH_SIDE_EFFECTS', 'PROVIDER_DISPATCH_AND_CONTINUATIONS',
 'SOURCE_AUDIO_AND_SUMMARY', 'USAGE_QUOTA_APPROVAL_AND_RECEIPTS', 'CREDENTIAL_MUTATIONS',
 'LOCAL_RUNNER_AND_OUTBOX', 'IMPORT_SAVE_AND_CANCEL', 'ANALYSIS_DELETE_AND_CLEANUP',
 'QUEUES_AND_SCHEDULES', 'OTHER_WORKERS_AND_SERVICE_BINDINGS', 'BUILDS_AND_DEPLOYMENTS',
 'MIGRATION_AND_DATABASE_ADMIN', 'RESTORE_AND_DIRECT_DATABASE_WRITERS'
]);
const SOURCE = '04de16a15c295e1d1c172dcc799dc15d293b8721b5db58f9dae0d94ed9f21e01';
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STORE_MARKER = 'SYNTHETIC_OFFLINE_OPERATIONAL_CONTRACT_V1';
const stores = new WeakMap(), capabilities = new WeakMap(), snapshots = new WeakMap();
const targets = new WeakMap(), rollbackPlans = new WeakMap(), memoryDatabaseKeys = new WeakMap();
const fixtureBindings = new WeakMap();
let observationSequence=0;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const clone = value => JSON.parse(JSON.stringify(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const flags = Object.freeze({productionExecutionSupported:false, operationallyAuthorized:false,
 productionEnforcementVerified:false, writesMayResume:false, keepWriteFence:true});
function fail(code) { throw Object.assign(new Error('OPERATIONAL_CONTRACT_' + code), {code:'OPERATIONAL_CONTRACT_' + code}); }
function freeze(value) { if(value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function clock(now) { if(!Number.isSafeInteger(now) || now < 0) fail('CLOCK_INVALID'); return now; }
function fresh(at, now) { if(!Number.isSafeInteger(at) || at > now || now-at > operationalEvidenceMaxAgeMs) fail('EVIDENCE_STALE'); }
function keys(value, names) { return value && typeof value==='object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...names].sort()); }

export function canonicalOperationalIdentity(value) {
 const names=['evidenceKind','sourceCommit','versionId','artifactSha256','databaseIdentitySha256','configurationSha256','ownerPolicySha256','ownerOnlyEnforced','importDeletionCompatibility'];
 if(!keys(value,names) || value.evidenceKind!=='SYNTHETIC_OFFLINE_CONTRACT'
  || !COMMIT.test(value.sourceCommit) || !VERSION.test(value.versionId)
  || !['artifactSha256','databaseIdentitySha256','configurationSha256','ownerPolicySha256'].every(key=>SHA.test(value[key]))
  || value.ownerOnlyEnforced!==true || !['NONE',IMPORT_DELETE_COMPATIBILITY].includes(value.importDeletionCompatibility)) fail('SYNTHETIC_IDENTITY_REQUIRED');
 return freeze(Object.fromEntries(names.map(name=>[name,value[name]])));
}

function localDatabase(database, emptyRequired=false) {
 if(!(database instanceof DatabaseSync) || database.isTransaction) fail('LOCAL_DATABASE_REQUIRED');
 if(database.prepare('PRAGMA database_list').all().some(item=>!['main','temp'].includes(item.name))) fail('ATTACHED_DATABASE_FORBIDDEN');
 if(database.prepare('SELECT count(*) AS n FROM sqlite_temp_master').get().n) fail('TEMP_SCHEMA_FORBIDDEN');
 const path=database.location('main');
 if(path && path!==':memory:') {
  const actual=realpathSync(path), rel=relative(realpathSync(tmpdir()),actual);
  if(!rel || rel.startsWith('..') || isAbsolute(rel)) fail('TEMP_DATABASE_REQUIRED');
 }
 if(emptyRequired && database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n) fail('SEPARATE_EMPTY_STORE_REQUIRED');
 return path;
}
function databaseKey(database) {
 const path=localDatabase(database);
 if(!path || path===':memory:') { if(!memoryDatabaseKeys.has(database)) memoryDatabaseKeys.set(database,randomUUID()); return hash(memoryDatabaseKeys.get(database)); }
 const actual=realpathSync(path), stat=statSync(actual); return digest({path:actual,device:stat.dev,inode:stat.ino});
}

/** Atomic CAS is exercised with local SQLite. No remote store is accepted. */
export function createOfflineOperationalStore({database}={}) {
 localDatabase(database);
 const objects=database.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
 const ddl='CREATE TABLE offline_operational_contract (singleton INTEGER PRIMARY KEY CHECK(singleton=1), marker TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), payload TEXT)';
 if(objects.length===0) {
  localDatabase(database,true); database.exec(ddl);
  database.prepare('INSERT INTO offline_operational_contract VALUES (1,?,0,NULL)').run(STORE_MARKER);
 } else if(objects.length!==1 || objects[0].name!=='offline_operational_contract' || objects[0].sql!==ddl) fail('STORE_SCHEMA_MISMATCH');
 const validateStore=()=>{
  localDatabase(database);
  const current=database.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if(current.length!==1 || current[0].name!=='offline_operational_contract' || current[0].sql!==ddl) fail('STORE_SCHEMA_MISMATCH');
 };
 const read=()=>{
  validateStore();
  const rows=database.prepare('SELECT marker,revision,payload FROM offline_operational_contract').all();
  if(rows.length!==1 || rows[0].marker!==STORE_MARKER || !Number.isSafeInteger(rows[0].revision)) fail('STORE_CORRUPT');
  let state; try { state=rows[0].payload===null ? null : JSON.parse(rows[0].payload); } catch { fail('STORE_CORRUPT'); }
  return {revision:rows[0].revision,state};
 };
 const cas=(revision,state)=>{
  validateStore();
  try { return database.prepare('UPDATE offline_operational_contract SET revision=revision+1,payload=? WHERE singleton=1 AND marker=? AND revision=?')
   .run(JSON.stringify(state),STORE_MARKER,revision).changes===1; }
  catch { fail('STORE_OUTCOME_UNCONFIRMED'); }
 };
 const store=Object.freeze({kind:STORE_MARKER,...flags});
 stores.set(store,{read,cas,databaseKey:databaseKey(database)}); return store;
}


function inventoryValue(inventory,identity) {
 if(!Array.isArray(inventory) || inventory.length!==requiredOperationalWriterClasses.length) fail('FULL_WRITER_INVENTORY_REQUIRED');
 const result=inventory.map(item=>{
  if(!keys(item,['writerClass','instances','absence']) || !requiredOperationalWriterClasses.includes(item.writerClass) || !Array.isArray(item.instances)) fail('WRITER_INVENTORY_INVALID');
  if(item.instances.length>100 || (item.instances.length===0 ? item.absence!=='SYNTHETIC_FIXTURE_NOT_CONFIGURED' : item.absence!==null)) fail('WRITER_ABSENCE_UNPROVED');
  const instances=item.instances.map(instance=>{
   if(!keys(instance,['id','sourceCommit']) || !/^fixture-[a-z0-9_-]{1,80}$/.test(instance.id) || instance.sourceCommit!==identity.sourceCommit) fail('WRITER_INSTANCE_INVALID');
   return {id:instance.id,sourceCommit:instance.sourceCommit};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  if(new Set(instances.map(item=>item.id)).size!==instances.length) fail('WRITER_INSTANCE_DUPLICATED');
  return {writerClass:item.writerClass,instances,absence:item.absence};
 }).sort((a,b)=>a.writerClass.localeCompare(b.writerClass));
 if(new Set(result.map(item=>item.writerClass)).size!==requiredOperationalWriterClasses.length) fail('WRITER_CLASS_DUPLICATED');
 return result;
}
function instanceKey(writerClass,writerId) { return writerClass+':'+writerId; }
function validateState(state) {
 if(!state || state.kind!==STORE_MARKER || !Number.isSafeInteger(state.epoch) || state.epoch<0
  || !['OPEN','CLOSING','FENCED','MIGRATION_RESERVED','MIGRATION_ACTIVE','MIGRATION_ACKNOWLEDGED','MIGRATION_UNKNOWN','MIGRATION_POSTCHECK_FAILED','ROLLBACK_PREPARED','ROLLBACK_VERIFIED_CLOSED','BLOCKED'].includes(state.phase)) fail('STORE_CORRUPT');
 canonicalOperationalIdentity(state.identity);
 if(digest(inventoryValue(state.inventory,state.identity))!==state.inventorySha256) fail('STORE_CORRRUPT_INVENTORY');
 if(!Array.isArray(state.admissions) || !Array.isArray(state.acks)) fail('STORE_CORRUPT');
 return state;
}
function assertClean(snapshot) {
 const state=snapshot.importState;
 if(state.pendingDeletions) fail('DELETION_NOT_DRAINED');
 if(state.orphanImports || state.orphanRequests || state.invalidRequestStates) fail('IMPORT_INTEGRITY_FAILED');
}

/** Captures actual local rows/DDL; opaque receipt cannot be replaced by JSON. */
export function captureOfflineOperationalDataSnapshot({database,identity,now=Date.now()}={}) {
 const canonical=canonicalOperationalIdentity(identity); clock(now);
 const schema=inspectManualSummaryImportSchema(database);
 if(!['ABSENT','EXACT'].includes(schema.state)) fail('FULL_IMPORT_DDL_REQUIRED');
 const before=captureLocalRollbackSnapshot(database,{now});
 const repeatedSchema=inspectManualSummaryImportSchema(database);
 if(repeatedSchema.schemaSha256!==schema.schemaSha256)fail('DATA_CAPTURE_CHANGED');
 const captured=captureLocalRollbackSnapshot(database,{now}); assertClean(captured);
 if(captured.databaseSha256!==before.databaseSha256) fail('DATA_CAPTURE_CHANGED');
 const receipt=freeze({kind:'SYNTHETIC_OFFLINE_DATA_OBSERVATION',capturedAt:now,
  databaseSha256:captured.databaseSha256,importSchemaSha256:schema.schemaSha256,
  schemaState:schema.state,importState:captured.importState,...flags});
 snapshots.set(receipt,{identity:canonical,snapshot:captured,database,databaseKey:databaseKey(database),sequence:++observationSequence}); return receipt;
}

/** Bytes are verified locally; source/version/owner claims remain synthetic. */
export function captureOfflineOperationalTarget({identity,artifactBytes,configurationBytes,ownerPolicyBytes,now=Date.now()}={}) {
 const canonical=canonicalOperationalIdentity(identity); clock(now);
 for(const [bytes,field] of [[artifactBytes,'artifactSha256'],[configurationBytes,'configurationSha256'],[ownerPolicyBytes,'ownerPolicySha256']]) {
  if(!(bytes instanceof Uint8Array) || hash(bytes)!==canonical[field]) fail('TARGET_ARTIFACT_BYTES_MISMATCH');
 }
 const receipt=freeze({kind:'SYNTHETIC_OFFLINE_TARGET_OBSERVATION',capturedAt:now,identity:canonical,...flags});
 targets.set(receipt,{identity:canonical,sequence:++observationSequence}); return receipt;
}

export function createOfflineOperationalController({store,now=Date.now}={}) {
 const persistence=stores.get(store); if(!persistence || typeof now!=='function') fail('OFFLINE_STORE_REQUIRED');
 const at=()=>clock(now());
 const load=()=>{ const record=persistence.read(); if(record.state) validateState(record.state); return record; };
 const mutate=async (transition,allowEmpty=false)=>{
  // No mutation is retried after an exception: a lost CAS acknowledgement has
  // an unknown outcome. CAS conflicts are retried only after a fresh read.
  for(let attempt=0;attempt<16;attempt++) {
   const record=load(); if(!record.state && !allowEmpty) fail('UNINITIALIZED');
   const timestamp=at(); if(record.state && timestamp<record.state.lastAt) fail('CLOCK_ROLLBACK');
   const state=record.state ? clone(record.state) : null;
   const next=transition(state,timestamp,record.revision); next.lastAt=timestamp;
   if(persistence.cas(record.revision,next)) return {state:next,revision:record.revision+1};
  } fail('CAS_CONFLICT');
 };
 const status=()=>{
  const {state,revision}=load(); if(!state) fail('UNINITIALIZED');
  const timestamp=at(); if(timestamp<state.lastAt) fail('CLOCK_ROLLBACK');
  return freeze({kind:STORE_MARKER,phase:state.phase,epoch:state.epoch,revision,
   inventorySha256:state.inventorySha256,windowSha256:state.windowSha256??null,
   activeAdmissions:state.admissions.filter(item=>item.outcome==='PENDING').length,
   unknownAdmissions:state.admissions.filter(item=>item.outcome==='UNKNOWN').length,
   acknowledgedWriters:state.acks.length,reason:state.reason??null,...flags});
 };
 const requireWindow=(state,timestamp)=>{
  if(!['FENCED','MIGRATION_RESERVED','MIGRATION_ACTIVE','MIGRATION_ACKNOWLEDGED','MIGRATION_UNKNOWN','MIGRATION_POSTCHECK_FAILED','ROLLBACK_PREPARED','ROLLBACK_VERIFIED_CLOSED'].includes(state.phase)) fail('ALL_WRITERS_NOT_FENCED');
  fresh(state.fencedAt,timestamp); fresh(state.inventoryAt,timestamp);
  if(state.admissions.some(item=>['PENDING','UNKNOWN'].includes(item.outcome))) fail('ADMISSIONS_NOT_DRAINED');
 };
 const requireDrain=(state,timestamp)=>{
  if(state.phase!=='CLOSING') fail('CLOSE_NOT_REQUESTED');fresh(state.inventoryAt,timestamp);
  if(state.admissions.some(item=>['PENDING','UNKNOWN'].includes(item.outcome))) fail('ADMISSIONS_NOT_DRAINED');
  const expected=state.inventory.flatMap(item=>item.instances.length?item.instances.map(instance=>instanceKey(item.writerClass,instance.id)):[instanceKey(item.writerClass,'ABSENT')]).sort();
  if(!same(state.acks.map(item=>item.key).sort(),expected) || state.acks.some(item=>item.epoch!==state.epoch || item.at<state.closedAt)) fail('ALL_WRITER_ACKS_REQUIRED');
  state.acks.forEach(item=>fresh(item.at,timestamp));
 };
 const internal={store,load,mutate,at,requireWindow};
 const controller={
  async initialize({identity,inventory}={}) {
   const canonical=canonicalOperationalIdentity(identity), checked=inventoryValue(inventory,canonical);
   await mutate((state,timestamp)=>{
    if(state) fail('ALREADY_INITIALIZED');
    return {kind:STORE_MARKER,identity:canonical,inventory:checked,inventorySha256:digest(checked),inventoryAt:timestamp,
     phase:'OPEN',epoch:0,admissions:[],acks:[],closedAt:null,fencedAt:null,windowSha256:null,reason:null};
   },true); return status();
  },
  status,
  createWriter({writerClass,writerId,sourceCommit}={}) {
   const record=load(); if(!record.state) fail('UNINITIALIZED');
   const found=record.state.inventory.find(item=>item.writerClass===writerClass)?.instances.find(item=>item.id===writerId);
   if(!found || found.sourceCommit!==sourceCommit) fail('WRITER_UNREGISTERED');
   const key=instanceKey(writerClass,writerId);
   return Object.freeze({
    async admit() {
     const ticketId=randomUUID();
     await mutate((state,timestamp)=>{
      if(state.phase!=='OPEN') fail('WRITES_CLOSED'); fresh(state.inventoryAt,timestamp);
      if(state.identity.sourceCommit!==sourceCommit) fail('WRITER_SOURCE_CHANGED');
      state.admissions.push({ticketId,key,epoch:state.epoch,admittedAt:timestamp,outcome:'PENDING'}); return state;
     });
     return freeze({kind:'SYNTHETIC_DURABLE_ADMISSION',ticketId,writerKeySha256:hash(key),...flags});
    },
    async complete({ticket,outcome}={}) {
     if(!ticket || ticket.kind!=='SYNTHETIC_DURABLE_ADMISSION' || !['CONFIRMED','UNKNOWN'].includes(outcome)) fail('ADMISSION_INVALID');
     await mutate(state=>{
      const entry=state.admissions.find(item=>item.ticketId===ticket.ticketId && item.key===key);
      if(!entry || entry.outcome!=='PENDING') fail('ADMISSION_NOT_PENDING');
      // Completion may arrive after close. It remains part of the drain; a
      // missing/uncertain acknowledgement is persisted and never timed out.
      entry.outcome=outcome; return state;
     }); return status();
    },
    async checkpointClosed() {
     await mutate((state,timestamp)=>{
      if(state.phase!=='CLOSING') fail('CLOSE_NOT_REQUESTED');
      if(state.admissions.some(item=>item.key===key && ['PENDING','UNKNOWN'].includes(item.outcome))) fail('WRITER_NOT_DRAINED');
      if(!state.acks.some(item=>item.key===key)) state.acks.push({key,epoch:state.epoch,at:timestamp,sourceCommit});
      return state;
     }); return status();
    },
    // A production writer would need a durable, atomic admission for each D1
    // mutation, not a remembered OPEN boolean, stale lease or UI maintenance flag.
    ...flags
   });
  },
  async close() {
   await mutate((state,timestamp)=>{
    if(state.phase==='OPEN') {state.phase='CLOSING';state.epoch++;state.closedAt=timestamp;state.acks=[];}
    return state;
   }); return status();
  },
  async acknowledgeAbsentClass({writerClass}={}) {
   await mutate((state,timestamp)=>{
    if(state.phase!=='CLOSING') fail('CLOSE_NOT_REQUESTED');
    const category=state.inventory.find(item=>item.writerClass===writerClass);
    if(!category || category.instances.length || category.absence!=='SYNTHETIC_FIXTURE_NOT_CONFIGURED') fail('WRITER_ABSENCE_UNPROVED');
    const key=instanceKey(writerClass,'ABSENT');
    if(!state.acks.some(item=>item.key===key)) state.acks.push({key,epoch:state.epoch,at:timestamp,sourceCommit:state.identity.sourceCommit});
    return state;
   }); return status();
  },
  captureDrainedSnapshot({database}={}) {
   const before=load();if(!before.state)fail('UNINITIALIZED');const timestamp=at();
   if(timestamp<before.state.lastAt)fail('CLOCK_ROLLBACK');requireDrain(before.state,timestamp);
   if(databaseKey(database)===persistence.databaseKey)fail('SEPARATE_DATA_DATABASE_REQUIRED');
   const receipt=captureOfflineOperationalDataSnapshot({database,identity:before.state.identity,now:timestamp});
   const after=load();if(after.revision!==before.revision)fail('DRAIN_WINDOW_CHANGED');
   snapshots.get(receipt).drainedAuthority={storeKey:persistence.databaseKey,revision:before.revision,epoch:before.state.epoch};
   return receipt;
  },
  async sealWindow({snapshot}={}) {
   const receipt=snapshots.get(snapshot); if(!receipt) fail('DATA_OBSERVATION_UNISSUED');
   await mutate((state,timestamp,revision)=>{
    requireDrain(state,timestamp);fresh(snapshot.capturedAt,timestamp);
    if(receipt.drainedAuthority?.storeKey!==persistence.databaseKey || receipt.drainedAuthority?.epoch!==state.epoch || receipt.drainedAuthority?.revision!==revision) fail('DRAINED_OBSERVATION_REQUIRED');
    if(snapshot.capturedAt<state.closedAt || !same(receipt.identity,state.identity)) fail('DATA_OBSERVATION_WRONG_WINDOW');
    if(receipt.databaseKey===persistence.databaseKey) fail('SEPARATE_DATA_DATABASE_REQUIRED');assertClean(receipt.snapshot);
    if(captureLocalRollbackSnapshot(receipt.database,{now:timestamp}).databaseSha256!==snapshot.databaseSha256)fail('DATA_CAPTURE_CHANGED');
    state.phase='FENCED';state.fencedAt=timestamp;state.baseline={databaseSha256:snapshot.databaseSha256,importSchemaSha256:snapshot.importSchemaSha256,databaseKey:receipt.databaseKey};
    state.windowSha256=digest({store:persistence.databaseKey,identity:state.identity,inventory:state.inventorySha256,epoch:state.epoch,closedAt:state.closedAt,baseline:state.baseline});
    return state;
   }); return status();
  },
  async reportUnknownWriter() {
   await mutate(state=>{state.phase='BLOCKED';state.reason='UNKNOWN_WRITER';return state;}); return status();
  },
  async issueMigrationCapability({sourceSha256}={}) {
   if(sourceSha256!==SOURCE) fail('0021_EXACT_SOURCE_REQUIRED');
   const operationId=randomUUID();
   const result=await mutate((state,timestamp)=>{
    requireWindow(state,timestamp); if(state.phase!=='FENCED') fail('OPERATION_ALREADY_RESERVED');
    state.phase='MIGRATION_RESERVED';state.operation={id:operationId,kind:'MIGRATION_0021',sourceSha256,attempted:false};return state;
   });
   const capability=freeze({kind:'SYNTHETIC_OFFLINE_0021_CAPABILITY',...flags});
   capabilities.set(capability,{internal,operationId,identity:result.state.identity,epoch:result.state.epoch,windowSha256:result.state.windowSha256,sourceSha256});
   return capability;
  },
  issueMigrationReadbackCapability({sourceSha256}={}) {
   if(sourceSha256!==SOURCE)fail('0021_EXACT_SOURCE_REQUIRED');
   const {state}=load();if(!state)fail('UNINITIALIZED');const timestamp=at();
   if(timestamp<state.lastAt)fail('CLOCK_ROLLBACK');requireWindow(state,timestamp);
   if(!['MIGRATION_ACTIVE','MIGRATION_ACKNOWLEDGED','MIGRATION_UNKNOWN','MIGRATION_POSTCHECK_FAILED'].includes(state.phase) || !state.operation?.attempted || state.operation.sourceSha256!==sourceSha256) fail('NO_ATTEMPT_TO_READ_BACK');
   const capability=freeze({kind:'SYNTHETIC_OFFLINE_0021_READBACK_CAPABILITY',readOnly:true,...flags});
   capabilities.set(capability,{internal,operationId:state.operation.id,identity:state.identity,epoch:state.epoch,windowSha256:state.windowSha256,sourceSha256,readOnly:true});
   return capability;
  },
  async prepareRollback({target,snapshot}={}) {
   const targetReceipt=targets.get(target), data=snapshots.get(snapshot);
   if(!targetReceipt || !data) fail('ROLLBACK_OBSERVATION_UNISSUED');
   const planId=randomUUID();
   const result=await mutate((state,timestamp)=>{
    requireWindow(state,timestamp); if(state.phase!=='FENCED') fail('OPERATION_ALREADY_RESERVED');
    fresh(target.capturedAt,timestamp);fresh(snapshot.capturedAt,timestamp);
    if(snapshot.capturedAt<state.closedAt || data.databaseKey!==state.baseline.databaseKey || snapshot.databaseSha256!==state.baseline.databaseSha256 || !same(data.identity,state.identity)) fail('ROLLBACK_BASELINE_CHANGED');
    if(captureLocalRollbackSnapshot(data.database,{now:timestamp}).databaseSha256!==snapshot.databaseSha256)fail('ROLLBACK_BASELINE_CHANGED');
    for(const key of ['databaseIdentitySha256','configurationSha256','ownerPolicySha256']) if(targetReceipt.identity[key]!==state.identity[key]) fail('ROLLBACK_IDENTITY_PRESERVATION_FAILED');
    assertClean(data.snapshot);
    if((snapshot.importState.imports || snapshot.importState.requests) && targetReceipt.identity.importDeletionCompatibility!==IMPORT_DELETE_COMPATIBILITY) fail('ROLLBACK_CLEANUP_INCOMPATIBLE');
    state.phase='ROLLBACK_PREPARED';state.rollback={id:planId,target:targetReceipt.identity,preparedAt:timestamp};return state;
   });
   const plan=freeze({kind:'SYNTHETIC_OFFLINE_ROLLBACK_PLAN',windowSha256:result.state.windowSha256,
    from:result.state.identity,target:targetReceipt.identity,...flags});
   rollbackPlans.set(plan,{internal,planId,epoch:result.state.epoch,windowSha256:result.state.windowSha256,preparedSequence:++observationSequence});return plan;
  },
  async verifyRollback({plan,observedTarget,snapshot}={}) {
   const held=rollbackPlans.get(plan), target=targets.get(observedTarget), data=snapshots.get(snapshot);
   if(!held || held.internal!==internal || !target || !data) fail('ROLLBACK_OBSERVATION_UNISSUED');
   try {
    await mutate((state,timestamp)=>{
     requireWindow(state,timestamp);
     if(state.phase!=='ROLLBACK_PREPARED' || state.rollback.id!==held.planId || state.epoch!==held.epoch || state.windowSha256!==held.windowSha256) fail('ROLLBACK_WINDOW_CHANGED');
     fresh(observedTarget.capturedAt,timestamp);fresh(snapshot.capturedAt,timestamp);
     if(target.sequence<=held.preparedSequence || data.sequence<=held.preparedSequence)fail('ROLLBACK_POSTCHECK_NOT_CAUSAL');
     if(observedTarget.capturedAt<state.rollback.preparedAt || snapshot.capturedAt<state.rollback.preparedAt) fail('ROLLBACK_POSTCHECK_TOO_OLD');
     if(!same(target.identity,state.rollback.target) || !same(data.identity,state.rollback.target)) fail('ROLLBACK_TARGET_MISMATCH');
     if(data.databaseKey!==state.baseline.databaseKey || snapshot.databaseSha256!==state.baseline.databaseSha256 || snapshot.importSchemaSha256!==state.baseline.importSchemaSha256) fail('ROLLBACK_DATA_CHANGED');
     if(captureLocalRollbackSnapshot(data.database,{now:timestamp}).databaseSha256!==snapshot.databaseSha256)fail('ROLLBACK_DATA_CHANGED');
     assertClean(data.snapshot);state.phase='ROLLBACK_VERIFIED_CLOSED';return state;
    });
   } catch(error) {
    await mutate(state=>{state.phase='BLOCKED';state.reason='ROLLBACK_POSTCHECK_FAILED';return state;}); throw error;
   }
   return freeze({kind:'SYNTHETIC_OFFLINE_ROLLBACK_RESULT',status:'OFFLINE_CONTRACT_VERIFIED_CLOSED',...flags});
  }
 };
 return Object.freeze(controller);
}

function heldCapability(capability,args) {
 const held=capabilities.get(capability); if(!held) fail('CAPABILITY_UNISSUED');
 if(!args || args.operation!=='MIGRATION_0021' || args.sourceSha256!==held.sourceSha256 || !same(canonicalOperationalIdentity(args.identity),held.identity)) fail('CAPABILITY_SCOPE_MISMATCH');
 return held;
}
function checkBinding(held,state,args) {
 const bound=fixtureBindings.get(args.binding);
 if(!bound || bound.databaseKey!==state.baseline.databaseKey || databaseKey(bound.database)!==bound.databaseKey)fail('D1_FIXTURE_DATABASE_MISMATCH');
 if(state.phase==='MIGRATION_RESERVED') {
  const actual=captureLocalRollbackSnapshot(bound.database,{now:held.internal.at()});
  if(actual.databaseSha256!==state.baseline.databaseSha256)fail('FENCED_DATA_BASELINE_CHANGED');
 }
}
function checkHeldState(held,state,timestamp) {
 held.internal.requireWindow(state,timestamp);
 if(state.epoch!==held.epoch || state.windowSha256!==held.windowSha256 || state.operation?.id!==held.operationId
  || !['MIGRATION_RESERVED','MIGRATION_ACTIVE','MIGRATION_ACKNOWLEDGED','MIGRATION_UNKNOWN','MIGRATION_POSTCHECK_FAILED'].includes(state.phase)) fail('CAPABILITY_WINDOW_CHANGED');
}
export async function assertOfflineOperationalCapability(capability,args) {
 const held=heldCapability(capability,args), {state}=held.internal.load(); const timestamp=held.internal.at();
 if(timestamp<state.lastAt) fail('CLOCK_ROLLBACK');checkHeldState(held,state,timestamp);checkBinding(held,state,args);
 return freeze({kind:'SYNTHETIC_OFFLINE_0021_WINDOW',windowSha256:held.windowSha256,epoch:held.epoch,phase:state.phase,readOnly:held.readOnly===true,...flags});
}
export async function beginOfflineOperationalMutation(capability,args) {
 const held=heldCapability(capability,args);
 if(held.readOnly)fail('READBACK_ONLY_CAPABILITY');
 await held.internal.mutate((state,timestamp)=>{
  checkHeldState(held,state,timestamp);checkBinding(held,state,args);
  if(state.phase!=='MIGRATION_RESERVED' || state.operation.attempted) fail('MUTATION_ALREADY_ATTEMPTED');
  state.operation.attempted=true;state.phase='MIGRATION_ACTIVE';return state;
 });
 return assertOfflineOperationalCapability(capability,args);
}
export async function finishOfflineOperationalMutation(capability,{outcome}={}) {
 const held=capabilities.get(capability); if(!held) fail('CAPABILITY_UNISSUED');
 if(held.readOnly)fail('READBACK_ONLY_CAPABILITY');
 if(!['ACKNOWLEDGED','UNKNOWN','POSTCHECK_FAILED'].includes(outcome)) fail('MUTATION_OUTCOME_INVALID');
 await held.internal.mutate((state,timestamp)=>{
  checkHeldState(held,state,timestamp);
  if(!['MIGRATION_ACTIVE','MIGRATION_ACKNOWLEDGED'].includes(state.phase)) fail('MUTATION_NOT_ACTIVE');
  // An ACK is only a modeled transport outcome, not verified preservation.
  // A later JS/readback failure can only close more firmly, never undo a D1 commit.
  if(state.phase==='MIGRATION_ACKNOWLEDGED' && outcome==='ACKNOWLEDGED') fail('MUTATION_ALREADY_ACKNOWLEDGED');
  state.phase='MIGRATION_'+outcome;return state;
 }); return freeze({kind:'SYNTHETIC_OFFLINE_MUTATION_OUTCOME',outcome,...flags});
}

// Native SQLite transactions below are contained inside this CLOSED synthetic
// binding fixture. They never travel through a D1 request. The private registry
// cannot register or relabel an arbitrary supplied binding. Fault hooks exercise
// uncertain transport outcomes only; they never constitute production evidence.
export function createOfflineD1FixtureBinding(database, options = {}) {
 localDatabase(database);
 const calls = {sessions: [], batches: 0, writeBatches: 0, statements: [], prepared: [], bookmarked: 0};
 const faults = {failWriteStatement: null, loseWriteAck: false, malformedWriteResult: false, dropReadRow: false, bookmark: 'normal', beforeBatch: null, afterWriteCommit: null, transformResults: null, ...options};
 let generation = 1;
 const statementOwners = new WeakMap();
 function convert(value) {
  if (typeof value === 'bigint') {
   const number = Number(value);
   if (!Number.isSafeInteger(number)) throw Error('Fixture refuses unsafe binding INTEGER transport');
   return number;
  }
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
 }
 const binding = {
  withSession(constraint) {
   calls.sessions.push(constraint);
   const sessionId = {}, state = {bookmark: null, minimumGeneration: generation};
   if (constraint !== 'first-primary') throw Error('Fixture requires fresh primary start');
   const session = {
    prepare(sql) {
     calls.prepared.push(sql);
     if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) throw Error('Transaction control must not be sent to D1');
     function statement(params = []) {
      const prepared = {bind(...values) { return statement(values); }};
      statementOwners.set(prepared, {sessionId, sql, params}); return Object.freeze(prepared);
     }
     return statement();
    },
    async batch(statements) {
     calls.batches++;
     const queries = statements.map(statement => {
      const query = statementOwners.get(statement);
      if (!query || query.sessionId !== sessionId) throw Error('Prepared statements belong to a different D1 session');
      return query;
     });
     const write = queries.some(query => /^\s*CREATE\b/i.test(query.sql));
     if (write) calls.writeBatches++;
     calls.statements.push(...queries.map(query => query.sql));
     if (faults.beforeBatch) await faults.beforeBatch({write, queries, calls, database});
     let results;
     database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
     try {
      results = queries.map((query, index) => {
       if (write && faults.failWriteStatement === index) throw Error('Synthetic private error body must be suppressed');
       const statement = database.prepare(query.sql); statement.setReadBigInts(true);
       const rows = statement.all(...query.params).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, convert(value)])));
       return {success: true, meta: {served_by_primary: true}, results: rows};
      });
      database.exec('COMMIT');
     } catch (error) { if (database.isTransaction) database.exec('ROLLBACK'); throw error; }
     if (write) {
      generation++;
      if (faults.afterWriteCommit) await faults.afterWriteCommit({database, calls});
      if (faults.loseWriteAck) throw Error('Synthetic committed batch ACK lost; must never replay');
      if (faults.malformedWriteResult) return [];
     }
     if (faults.dropReadRow && !write) {
      const data = queries.findIndex(query => /^SELECT typeof\(/.test(query.sql));
      if (data >= 0 && results[data].results.length) results[data].results.pop();
     }
     if(faults.transformResults) results=await faults.transformResults({write,queries,results});
     state.minimumGeneration = Math.max(state.minimumGeneration, generation);
     state.bookmark = `synthetic-opaque-${state.minimumGeneration}`;
     return results;
    },
    getBookmark() {
     calls.bookmarked++;
     if (faults.bookmark === 'null') return null;
     if (faults.bookmark === 'object') return {bookmark: state.bookmark};
     return state.bookmark;
    },
   };
   return Object.freeze(session);
  },
 };
 Object.freeze(binding); fixtureBindings.set(binding,{database,databaseKey:databaseKey(database)});
 return {binding, calls, faults, database};
}
