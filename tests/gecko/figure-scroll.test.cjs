const assert=require('node:assert/strict');
const {test}=require('node:test');
const {gecko}=require('../helpers/gecko.cjs');

test('privileged trimming of a content canvas leaves the UI event queue responsive', {timeout:30000}, async t=>{
  const browser=await gecko(t);
  const source=require('../helpers/figure-source.cjs')();
  const result=await browser.run(`
    const [source]=arguments,done=arguments[arguments.length-1],Cu=Components.utils;
    const browser=Services.appShell.createWindowlessBrowser(false),doc=browser.document;
    const win=Cu.waiveXrays(doc.defaultView);
    const script=doc.createElement('script');script.textContent='const c=document.createElement("canvas");c.width=c.height=3000;const ctx=c.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,3000,3000);ctx.fillStyle="blue";ctx.fillRect(100,100,2800,2800);window.sample=c.toDataURL();c.width=c.height=0;';doc.body.append(script);
    const plugin=Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{wantXrays:false});
    Object.assign(plugin,{doc,src:win.sample,setTimeout,clearTimeout,setInterval,clearInterval});
    Cu.evalInSandbox(source,plugin);
    Cu.evalInSandbox('(async()=>{const api=ZRBPDFFigureFallback,original=api.loadImage.bind(api);let ticks=0,timer,start;api.loadImage=async(...args)=>{await original(...args);start=Date.now();timer=setInterval(()=>ticks++,0);};const crop=await api.trimImage({doc,structure:{catalog:{pages:[{rotation:0}]}}},src,{direction:"above",rect:[0,0,600,600]},0);clearInterval(timer);return {ticks,elapsed:Date.now()-start,width:crop.width,height:crop.height};})()',plugin).then(done,e=>done({failure:String(e),stack:e.stack})).finally(()=>browser.close());
  `,[source],true);
  t.diagnostic(JSON.stringify(result));
  assert.ok(!result.failure,JSON.stringify(result));
  assert.ok(result.ticks>0,'Privileged pixel processing blocked the UI: '+JSON.stringify(result));
  assert.equal(result.width,2820);assert.equal(result.height,2820);
});
