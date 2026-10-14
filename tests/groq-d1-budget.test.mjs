import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groqD1Budget,GROQ_D1_MAX_QUERIES,GROQ_D1_POST_DISPATCH_RESERVE,GROQ_SYNTHESIS_PREFLIGHT_QUERIES} from '../src/groq-d1-budget.mjs';

test('D1 budget counts failed writes and blocks a provider before reserved recovery writes are consumed',async()=>{
 let calls=0,providerCalls=0;
 const db={prepare(){return {bind(){return this;},async first(){calls++;return {ok:1};},async run(){calls++;throw Error('D1_WRITE_ACK_LOST');}};}};
 const budget=groqD1Budget(db);
 for(let i=0;i<GROQ_D1_MAX_QUERIES-GROQ_SYNTHESIS_PREFLIGHT_QUERIES-GROQ_D1_POST_DISPATCH_RESERVE;i++)await budget.DB.prepare('SELECT 1').first();
 budget.ensure(GROQ_SYNTHESIS_PREFLIGHT_QUERIES+GROQ_D1_POST_DISPATCH_RESERVE);
 await assert.rejects(budget.DB.prepare('INSERT INTO x').run(),/D1_WRITE_ACK_LOST/);
 assert.equal(budget.used(),calls);
 const dispatch=async()=>{budget.ensure(GROQ_SYNTHESIS_PREFLIGHT_QUERIES+GROQ_D1_POST_DISPATCH_RESERVE);providerCalls++;};
 await assert.rejects(dispatch(),error=>error.code==='GROQ_D1_BUDGET'&&error.preDispatchBlocked===true);
 assert.equal(providerCalls,0);
});
