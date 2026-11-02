const assert=require('node:assert/strict');
const {test}=require('node:test');
const {gecko}=require('../helpers/gecko.cjs');
test('a genuinely dead Gecko wrapper is pruned without breaking live figure memory management',{timeout:30000},async t=>{
  const browser=await gecko(t);
  const result=await browser.run(`
    const [source]=arguments,Cu=Components.utils;
    const dead=Cu.Sandbox('https://example.invalid',{wantXrays:false});
    const doc=Cu.evalInSandbox('({get documentElement(){return {clientHeight:600}}})',dead);
    Cu.nukeSandbox(dead);
    let reproduced=false;try{void doc.documentElement}catch(e){reproduced=String(e).includes('dead object')}
    const plugin=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{wantXrays:false});
    const live=Services.appShell.createWindowlessBrowser(false);
    Object.assign(plugin,{deadDoc:doc,liveDoc:live.document,setTimeout,clearTimeout});Cu.evalInSandbox(source,plugin);
    const outcome=Cu.evalInSandbox('(()=>{const api=ZRBPDFFigureFallback,state={doc:deadDoc,regions:new Map(),previews:new Map()};api.states.set(deadDoc,state);api.states.set(liveDoc,{doc:liveDoc,regions:new Map(),previews:new Map()});api.enforceMemory();return {remaining:api.states.size,disposed:state.disposed,live:api.states.has(liveDoc)};})()',plugin);
    live.close();return {reproduced,remaining:outcome.remaining,disposed:outcome.disposed,live:outcome.live};
  `,[require('../helpers/figure-source.cjs')()]);
  assert.equal(result.reproduced,true,'fixture must cross a genuinely dead Gecko wrapper');
  assert.equal(result.remaining,1);assert.equal(result.disposed,true);assert.equal(result.live,true);
});
