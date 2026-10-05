import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../server/index.mjs',import.meta.url),'utf8');
const ticker=source.slice(source.indexOf('let broadcastFrame = 0;'),source.indexOf('const heartbeat = setInterval'));
test('congested clients get fresh authority snapshots after draining, without stopping game ticks',()=>{
  let frame, ticks=0, snapshots=0;
  const slow={readyState:1,bufferedAmount:100},fast={readyState:1,bufferedAmount:0},sent=[];
  const clients=new Map([[slow,{joined:true,id:'slow'}],[fast,{joined:true,id:'fast'}]]);
  const game={tick(){ticks++;},state(id){snapshots++;return {id,ticks};}};
  new Function('setInterval','game','clients','WebSocket','send',ticker)(fn=>{frame=fn;},game,clients,{OPEN:1},(ws,data)=>sent.push({ws,data}));
  for(let i=0;i<10;i++)frame();
  assert.equal(ticks,10);assert.equal(snapshots,5);assert.ok(sent.every(item=>item.ws===fast));
  slow.bufferedAmount=0;frame();frame();
  assert.equal(sent.find(item=>item.ws===slow).data.state.ticks,12);
});
