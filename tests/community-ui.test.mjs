import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/community.ts',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'').replace('export function createCommunityUI','function createCommunityUI');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

// Real community module on a strict DOM fixture: HTML sinks throw, so player
// names, chat bodies and ledger content must be assigned as text nodes.
function fixture({mobile=false,saved=null,publicResponse=null}={}){
  let document;
  class Element extends EventTarget {
    children=[];_text='';className='';attributes=new Map();hidden=false;disabled=false;value='';scrollTop=0;scrollHeight=100;clientHeight=100;
    constructor(tag){super();this.tagName=tag.toUpperCase();const classes=new Set();this.classList={toggle:(key,force)=>{const enable=force??!classes.has(key);if(enable)classes.add(key);else classes.delete(key);return enable;},contains:key=>classes.has(key)};}
    set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set innerHTML(_value){throw new Error('Untrusted HTML insertion is forbidden in community surfaces');}
    get childElementCount(){return this.children.length;}
    append(...children){this.children.push(...children);}replaceChildren(...children){this._text='';this.children=[];this.append(...children);}
    setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key);}
    focus(){document.activeElement=this;this.dispatchEvent(new Event('focus'));}blur(){if(document.activeElement===this)document.activeElement=null;}
    click(){this.dispatchEvent(new Event('click'));}
  }
  const app=new Element('main'),host=new Element('section');app.append(host);
  document={body:new Element('body'),activeElement:null,hidden:false,title:'',createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),querySelector:selector=>selector==='#app'?app:null};
  const window=new EventTarget(),timers=new Map();let timerId=0;window.setTimeout=callback=>{timers.set(++timerId,callback);return timerId;};
  const clearTimeout=id=>timers.delete(id);
  const values=new Map(saved===null?[]:[['lootmon-chat-open',String(saved)]]),localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const location={pathname:'/'},history={pushState:(_state,_unused,path)=>{location.pathname=path;}};
  const session={wallet:null,canChat:false,connected:false},sent=[],routes=[],requests=[],intervals=[];let focusCalls=0;
  let boardResponse={updatedAt:1700000000000,totalCollectors:0,entries:[]};
  const response=data=>({ok:true,json:async()=>data});
  const fetch=async path=>{requests.push(path);if(path==='/api/community')return publicResponse?await publicResponse.promise:response({chat:[],activity:[]});if(path==='/api/leaderboard')return response(boardResponse);throw new Error('Unexpected fixture request');};
  const dependencies={document,window,location,history,localStorage,fetch,navigator:{},setInterval:callback=>{intervals.push(callback);return intervals.length;},setTimeout:window.setTimeout,clearTimeout,matchMedia:()=>({matches:mobile})};
  const create=new Function(...Object.keys(dependencies),`${compiled}\nreturn createCommunityUI;`)(...Object.values(dependencies));
  const ui=create({host,getSession:()=>session,send:text=>sent.push(text),onFocus:()=>{focusCalls++;},onRoute:route=>routes.push(route)});
  const walk=node=>[node,...(node.children??[]).flatMap(walk)];
  const find=predicate=>walk(app).find(predicate),all=predicate=>walk(app).filter(predicate);
  const id=value=>find(node=>node.id===value),css=value=>find(node=>node.className?.split(' ').includes(value));
  return {ui,session,document,window,location,requests,sent,routes,values,intervals,timers,id,css,all,focusCalls:()=>focusCalls,setBoard:data=>{boardResponse=data;}};
}
const message=(id,text='Hello island')=>({id,kind:'player',name:'Collector',text,time:1700000000000});

test('chat renders hostile player text literally and only validated bot transaction signatures become links',async()=>{
  const f=fixture();await flush();
  const hostile='<img src=x onerror=alert(1)>',signature='4'.repeat(88);
  f.ui.receive({chat:[{...message('player',hostile),name:hostile,signature},{...message('bot','Confirmed win'),kind:'bot',signature},{...message('bad','Unsafe link'),kind:'bot',signature:'javascript:alert(1)'}],activity:[]});
  assert.match(f.id('community-messages').textContent,/<img src=x onerror=alert\(1\)>/);
  const links=f.all(node=>node.tagName==='A');assert.equal(links.length,1);assert.equal(links[0].href,`https://solscan.io/tx/${signature}`);assert.equal(links[0].rel,'noopener noreferrer');
  assert.equal(f.all(node=>node.tagName==='IMG'&&node.src!=='/art/looter-avatar.png').length,0);
  f.css('community-copy').click();await flush();
  assert.equal(f.css('community-reference').open,true,'No clipboard API exposes selectable full signature');
});

test('chat stays read-only until a verified hunt, acknowledges sends, preserves a newly edited draft and clears movement focus',async()=>{
  const f=fixture();await flush();const input=f.id('community-chat-input'),form=f.css('community-composer');
  input.value='Blocked';form.dispatchEvent(new Event('submit',{cancelable:true}));assert.deepEqual(f.sent,[]);assert.equal(input.disabled,true);
  Object.assign(f.session,{wallet:'walletA',canChat:true,connected:true});f.ui.refreshSession();assert.equal(input.disabled,false);
  const before=f.focusCalls();input.focus();assert.equal(f.focusCalls(),before+1);
  input.value='/help';form.dispatchEvent(new Event('submit',{cancelable:true}));form.dispatchEvent(new Event('submit',{cancelable:true}));assert.deepEqual(f.sent,['/help']);
  input.value='Next thought';f.ui.ack({ok:true});assert.equal(input.value,'Next thought');
  form.dispatchEvent(new Event('submit',{cancelable:true}));f.ui.ack({ok:false,reason:'Wait 3 seconds.'});assert.equal(input.value,'Next thought');assert.equal(f.css('community-hint').textContent,'Wait 3 seconds.');
  const escape=new Event('keydown',{cancelable:true});Object.defineProperty(escape,'key',{value:'Escape'});input.dispatchEvent(escape);assert.equal(f.document.activeElement,null);assert.equal(escape.defaultPrevented,true);
});

test('hidden chat counts only new messages and remembers visibility; mobile stays collapsed by default',async()=>{
  const f=fixture({mobile:true});await flush();Object.assign(f.session,{wallet:'walletA',canChat:true,connected:true});f.ui.refreshSession();
  assert.equal(f.id('island-chat-panel').hidden,true);
  f.ui.receive({chat:[message('1')],activity:[]});f.ui.receive({chat:[message('1'),message('2')],activity:[]});f.ui.receive({chat:[message('1'),message('2')],activity:[]});
  assert.equal(f.css('community-unread').textContent,'2');
  f.id('community-toggle').click();assert.equal(f.id('island-chat-panel').hidden,false);assert.equal(f.css('community-unread').hidden,true);assert.equal(f.values.get('lootmon-chat-open'),'true');
  const hide=f.all(node=>node.getAttribute?.('aria-label')==='Hide chat')[0];hide.click();assert.equal(f.values.get('lootmon-chat-open'),'false');
  f.ui.refreshSession();assert.equal(f.id('island-chat-panel').hidden,true);
});

test('a late public poll cannot replace newer websocket community history',async()=>{
  const pending=deferred(),f=fixture({publicResponse:pending});
  f.ui.receive({chat:[message('new','Newest live event')],activity:[]});
  pending.resolve({ok:true,json:async()=>({chat:[message('old','Stale poll')],activity:[]})});await flush();
  assert.match(f.id('community-messages').textContent,/Newest live event/);assert.doesNotMatch(f.id('community-messages').textContent,/Stale poll/);
});

test('leaderboard route releases controls without changing the active session and renders real pending/confirmed ledger fields',async()=>{
  const f=fixture();await flush();Object.assign(f.session,{wallet:'walletA',canChat:true,connected:true});
  f.setBoard({updatedAt:1700000000000,totalCollectors:1,entries:[{rank:1,wallet:'walletA',name:'<b>Alice</b>',character:'sage',wins:2,totalValue:175,secured:3,pending:1,online:true}]});
  f.ui.navigate('/leaderboard');await flush();
  assert.equal(f.location.pathname,'/leaderboard');assert.equal(f.document.body.classList.contains('leaderboard-page'),true);assert.equal(f.id('leaderboard-page').hidden,false);assert.equal(f.session.canChat,true);assert.equal(f.session.connected,true);
  assert.match(f.css('leaderboard-results').textContent,/<b>Alice<\/b>/);assert.match(f.css('leaderboard-results').textContent,/3 secured · 1 pending/);assert.match(f.css('leaderboard-results').textContent,/\$175/);assert.match(f.css('leaderboard-results').textContent,/CARD VALUE/);
  f.ui.navigate('/');assert.equal(f.id('leaderboard-page').hidden,true);assert.equal(f.document.body.classList.contains('leaderboard-page'),false);assert.deepEqual(f.routes,[false,true,false]);assert.equal(f.session.wallet,'walletA');
});
