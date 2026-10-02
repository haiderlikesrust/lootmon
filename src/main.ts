import './style.css';
import './game-ui.css';
import './trainer-ui.css';
import './community.css';
import {createCommunityUI} from './community';
import { CHARACTER_OPTIONS, type CharacterVariant } from './characters';
import {drawIslandMap,DISTRICT_INFO} from './map';
import {GameAudio} from './audio';
import {createIcons, Compass, Wallet, ArrowUpRight, Layers, Map as MapIcon, Backpack, Settings2, CircleHelp, X, ShieldCheck, Radio, Zap, Home, LockKeyhole, Gem, ChevronRight, Trophy, Volume2, Crosshair, Users, Clock3, Copy, Check, Maximize2, Leaf, ExternalLink, LogOut} from 'lucide';
import {Game} from './game';
import {startNavigationHUD} from './navigation-hud';
import type {GameState,Config,Reward} from './types';

const icons={Compass,Wallet,ArrowUpRight,Layers,Map:MapIcon,Backpack,Settings2,CircleHelp,X,ShieldCheck,Radio,Zap,Home,LockKeyhole,Gem,ChevronRight,Trophy,Volume2,Crosshair,Users,Clock3,Copy,Check,Maximize2,Leaf,ExternalLink,LogOut};
const icon=(name:string,cls='')=>`<i data-lucide="${name}" class="${cls}"></i>`;
const app=document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML=`
<header class="topbar">
  <a class="brand" href="/" aria-label="Lootmon home"><img class="brand-logo" src="/brand/lootmon-logo.webp" alt="Lootmon" width="960" height="247" fetchpriority="high"/></a>
  <nav aria-label="Main navigation"><button class="nav-item active" data-tab="play">${icon('compass')}PLAY</button><button class="nav-item" data-tab="collection">${icon('backpack')}CARD VAULT<span id="collection-count">0</span></button><button class="nav-item" data-tab="leaderboard">${icon('trophy')}LEADERBOARD</button><button class="nav-item" data-tab="treasury">${icon('gem')}TREASURY</button></nav>
  <div class="header-right"><span class="network">SOLANA</span><button class="wallet-button" id="wallet-button">${icon('wallet')}<span>Connect wallet</span></button></div>
</header>
<main class="workspace">
  <aside class="sidebar">
    <div class="season-label"><span class="tiny-line"></span> TRAINER CARD <span class="season-tag">WORLD 01</span></div>
    <h1>READY,<br><span>COLLECTOR?</span></h1>
    <p class="intro">Your next Pokémon card is out there.<br>Find it. Grab it. Get it home!</p>
    <div class="location-card"><div class="location-mark">${icon('compass')}</div><div><span class="eyebrow">CURRENT REGION</span><strong>Verdant Isle</strong><span class="muted">Houses · Forests · Ancient ruins</span></div><span class="location-number">01</span></div>
    <div class="section-title"><h2>YOUR QUEST</h2><button class="text-button" id="how-button">Controls ${icon('arrow-up-right')}</button></div>
    <ol class="steps"><li><span>01</span><div><strong>SEARCH THE ISLAND</strong><p>Check houses, trails & secret spots.</p></div></li><li><span>02</span><div><strong>GRAB A PACK</strong><p>Go further to find rarer rewards.</p></div></li><li><span>03</span><div><strong>RACE TO YOUR BASE</strong><p>Watch out! Rivals can steal it.</p></div></li></ol>
    <div class="access-card"><div>${icon('shield-check')}<strong>Holder access</strong><span>0.25%+</span></div><p>Hold at least 0.25% of the game token supply to enter the hunt.</p><button id="perks-button">${icon('zap')}Over 2% unlocks timed tools ${icon('chevron-right')}</button></div>
    <div class="sidebar-bottom"><span class="eyebrow">YOUR ADVENTURE IS CALLING!</span><button id="enter-button" class="primary-button">${icon('wallet')}Connect to play ${icon('arrow-up-right')}</button><button id="explore-button" class="explore-button">${icon('map')}Explore island</button><div class="entry-note" id="entry-note">Wallet ownership is verified before entry</div></div>
  </aside>
  <section class="world-shell" aria-label="Interactive 3D game world">
    <div id="world"></div>
    <div class="world-vignette"></div>
    <div class="world-top"><div class="region-stack"><div class="region-pill">${icon('leaf')}<span>VERDANT ISLE</span><span class="pill-divider"></span><span id="session-status">YOUR COLLECTOR</span></div><div class="performance-hud" aria-label="Connection and rendering performance"><span title="Measured frames rendered per second"><strong id="fps-value">—</strong> FPS</span><span id="ping-label" title="Measured server round-trip time"><i class="ping-dot"></i><strong id="ping-value">—</strong> ms</span></div></div><div class="world-actions"><button id="sound-button" aria-label="Mute sound effects" title="Sound effects on">${icon('volume-2')}</button><button id="perspective-button" aria-label="Toggle character and island view" title="Character / island view">${icon('compass')}</button><button id="map-button" aria-label="Open island map" title="Island map">${icon('map')}</button><button id="settings-button" aria-label="Settings" title="Settings">${icon('settings-2')}</button><button id="fullscreen-button" aria-label="Toggle full screen" title="Full screen">${icon('maximize-2')}</button></div></div>
    <div class="compass" role="img" aria-label="Camera heading"><div id="compass-tape" aria-hidden="true"></div><b class="compass-pointer" aria-hidden="true"></b><span id="compass-home" hidden></span><strong id="compass-heading"></strong></div>
    <div class="world-location"><span class="eyebrow">CHOOSE YOUR COLLECTOR</span><h2>TRAIL SCOUT</h2><p>Find it. Defend it. Bring it home.</p></div>
    <div class="island-label"><span>01 / VERDANT ISLE</span><small>Drag to look around · Scroll to zoom</small></div>
    <div class="live-chip">${icon('users')}<span id="online-count">0 collectors</span></div>
    <div class="player-hud" hidden><div class="player-badge">${icon('compass')}<div><strong id="player-name">Collector</strong><span id="player-tier">HOLDER</span></div></div><div id="carry-status">${icon('backpack')}Your hands are free<span>Explore nearby hiding places</span></div></div>
    <button class="interaction" id="interaction" hidden><kbd>RMB</kbd><span>Pick up pack</span></button>
    <div class="game-tools" hidden><button id="interact-button" aria-label="Grab or snatch (right-click)" title="Grab a nearby pack or snatch a rival’s carried pack">${icon('crosshair')}<span>Grab / Snatch</span><kbd>RMB</kbd></button><button id="jump-button" aria-label="Jump (Space)" title="Jump">${icon('arrow-up-right')}<span>Jump</span><kbd>SPACE</kbd></button><button id="radar-button">${icon('radio')}<span>Pulse scan</span><kbd>Q</kbd></button><button id="dash-button">${icon('zap')}<span>Quickstep</span><kbd>F</kbd></button><button id="leave-button">${icon('log-out')}<span>Leave island</span></button></div>
    <div class="exploration-hud" hidden><strong>EXPLORE VERDANT ISLE</strong><span class="desktop-movement-hint"><kbd>WASD</kbd> Move <kbd>SHIFT</kbd> Sprint</span><span class="desktop-movement-hint"><kbd>SPACE</kbd> Jump <kbd>RMB</kbd> Grab / Snatch</span><span class="touch-movement-hint">Hold the arrows to walk. Hold Sprint to run.</span><span class="desktop-camera-hint" id="camera-hint">Click the island to look · <kbd>ESC</kbd> Return</span><span class="touch-camera-hint">Drag the island to look around.</span><small id="explorer-coordinates">Hearthwick village</small></div>
    <div class="touch-controls" hidden aria-label="Movement controls"><div class="touch-dpad"><button data-control="KeyW" aria-label="Move forward">▲</button><button data-control="KeyA" aria-label="Move left">◀</button><span aria-hidden="true">✦</span><button data-control="KeyD" aria-label="Move right">▶</button><button data-control="KeyS" aria-label="Move backward">▼</button></div><button data-control="ShiftLeft" class="touch-sprint" aria-label="Hold to sprint">SPRINT</button></div>
    <div class="minimap" role="button" tabindex="0" aria-label="Open live island map" hidden><canvas id="mini-canvas" width="360" height="360"></canvas><span>VERDANT ISLE</span></div>
    <div class="character-selector"><span>YOUR COLLECTOR</span><div>${CHARACTER_OPTIONS.map(o=>`<button data-character="${o.id}" title="${o.description}">${o.name}</button>`).join('')}</div><button id="character-cheer">${icon('trophy')}Strike a pose!</button></div><div class="pack-strip"><div class="strip-heading"><div><span class="eyebrow">FIND A PACK. CLAIM YOUR GRAIL.</span><h3>THE LOOT POOL</h3></div><span id="pack-total">Awaiting funded drops</span></div><div class="pack-tiers">${[25,50,100,250,500].map((v,i)=>`<div class="pack-tier tier-${v}"><span class="pack-token"><img src="/art/lootmon-pack-${v}.webp" alt="Lootmon ${['Scout','Explorer','Rare','Epic','Grail'][i]} foil pack" width="384" height="640"/></span><div><strong>$${v}</strong><span>${['SCOUT','EXPLORER','RARE','EPIC','GRAIL'][i]}</span></div>${i>2?icon('lock-keyhole','tier-lock'):''}</div>`).join('')}</div><div class="strip-foot"><span>${icon('shield-check')}Treasury-funded. Secured at your base.</span><button id="drop-button">Drop mechanics ${icon('arrow-up-right')}</button></div></div>
    <div class="loading-world" id="loading-world"><span class="loading-ring"></span>Discovering Verdant Isle…</div>
  </section>
</main>
<footer class="statusbar"><span><i class="status-dot"></i><span id="footer-status">Exploring the island</span></span><div class="project-links"><button id="contract-button" title="Game token contract address" aria-label="View game token contract address">${icon('copy')}<span id="contract-label">CA · Coming soon</span></button><button id="x-pending" title="X account link is coming soon" aria-label="Lootmon X account coming soon">𝕏 <span>Coming soon</span></button><a id="x-link" hidden target="_blank" rel="noopener noreferrer" aria-label="Lootmon on X">𝕏 <span>Follow Lootmon</span></a></div><button id="support-button">${icon('circle-help')} Field guide</button></footer>
<dialog id="modal"><div class="dialog-heading"><span id="modal-eyebrow" class="eyebrow">LOOTMON / VERDANT ISLE</span><button id="close-modal" aria-label="Close dialog">${icon('x')}</button></div><div id="modal-body"></div></dialog><div id="toast" role="status"></div>`;
function refreshIcons(){createIcons({icons,attrs:{'stroke-width':1.7}})}refreshIcons();
function $(s:'#modal'):HTMLDialogElement;
function $<T extends HTMLElement=HTMLElement>(s:string):T;
function $(s:string){return document.querySelector(s)!;}
const game=new Game($('#world'));
const audio=new GameAudio();game.onStep=sprint=>audio.step(sprint);
game.ready.then(()=>{$('#loading-world').classList.add('loaded');syncCharacters()}).catch(error=>{$('#loading-world').innerHTML=`<p>${esc(error.message)}</p><button id="retry-assets" class="primary-button">Retry character loading</button>`;$('#loading-world').style.pointerEvents='auto';$('#retry-assets').onclick=()=>location.reload();});

let config:Config={},state:GameState={players:[],packs:[],events:[],treasury:{}},myId:string|null=null,walletAddress='',walletProvider:any=null,socket:WebSocket|null=null,connecting=false,sessionReady=false;let collection:Reward[]=[];
let authRevision=0;
const community=createCommunityUI({
  host:$('.world-shell'),
  getSession:()=>({wallet:myId||(sessionReady?walletAddress:null),canChat:sessionReady&&!!myId&&game.playing&&socket?.readyState===WebSocket.OPEN,connected:socket?.readyState===WebSocket.OPEN}),
  send:text=>send({type:'chat',text}),
  onFocus:()=>{game.releasePointer();game.clearInput();},
  onRoute:leaderboard=>{$('#modal').close();for(const button of document.querySelectorAll<HTMLElement>('[data-tab]'))button.classList.toggle('active',button.dataset.tab===(leaderboard?'leaderboard':'play'));}
});
const cash=(v?:number)=>typeof v==='number'?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v):'—';
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function toast(message:string){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=window.setTimeout(()=>$('#toast').classList.remove('visible'),4500)}let toastTimer=0;
function modal(title:string,body:string){game.releasePointer();$('#modal').classList.remove('map-dialog');$('#modal-body').innerHTML=`<h2>${title}</h2>${body}`;$('#modal').showModal();game.clearInput();refreshIcons()}
$('#close-modal').onclick=()=>$('#modal').close();$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))$('#modal').close()});
async function api(path:string,body?:unknown){const r=await fetch(path,{credentials:'same-origin',method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error||data.message||'Unable to complete the request.');return data}
async function loadStatus(){try{config=await api('/api/config');updatePublicLinks();const status=await api('/api/status');if(!myId){if(status.state)state={...state,...status.state,players:[],packs:[],events:[]};else if(status.treasury)state={...state,...status,players:status.players??[],packs:[]};const count=status.state?.online??status.playerCount??status.online??status.players?.length??0;$('#online-count').textContent=`${count} collector${count===1?'':'s'}`;}
  const configured=Boolean(config.configured??config.authConfigured);if(!game.exploring)$('#footer-status').textContent=configured?'Wallet verification available':'Island ready · Token launch pending';$('#entry-note').textContent=configured?'Wallet ownership is verified before entry':'The game token is awaiting configuration';
  $('#explore-button').hidden=!configured;if(!configured){$('#enter-button').innerHTML=`${icon('compass')}EXPLORE ISLAND ${icon('arrow-up-right')}`;$('#entry-note').textContent='Walk the island · Live hunt opens with the token launch';}
  const total=state.packCounts?.total??0,queued=state.packCounts?.queued??0;$('#pack-total').textContent=total?`${total} funded packs on the island${queued?` · ${queued} queued`:''}`:queued?`${queued} funded packs awaiting a safe hiding spot`:'Awaiting funded drops';refreshIcons();
}catch{if(!game.exploring)$('#footer-status').textContent='Game server unavailable';$('#entry-note').textContent='Explore the island while the game server reconnects';$('#explore-button').hidden=false;}}
loadStatus();setInterval(loadStatus,15000);
function updatePublicLinks(){
  const address=config.site?.contractAddress;
  $('#contract-label').textContent=address?`CA · ${address.slice(0,5)}…${address.slice(-5)}`:'CA · Coming soon';
  $('#contract-button').title=address?`Copy contract address: ${address}`:'Game token contract address is not announced yet';
  const link=$<HTMLAnchorElement>('#x-link');link.hidden=true;link.removeAttribute('href');$('#x-pending').hidden=false;
  if(config.site?.xUrl){try{const url=new URL(config.site.xUrl);if(url.origin==='https://x.com'&&/^\/[A-Za-z0-9_]{1,15}$/.test(url.pathname)){link.href=url.href;link.hidden=false;$('#x-pending').hidden=true;}}catch{}}
}
$('#x-pending').onclick=()=>toast('The official Lootmon X account link is coming soon.');
$('#contract-button').onclick=async()=>{
  const address=config.site?.contractAddress;
  if(!address){toast('The game token contract address has not been announced yet.');return;}
  try{await navigator.clipboard.writeText(address);toast('Game token contract address copied.');}
  catch{modal('Game token contract',`<p class="contract-address">${esc(address)}</p><p>Select the address above to copy it.</p>`);}
};
let pingNonce=0,pendingPing:{socket:WebSocket;nonce:number;started:number}|null=null,httpPingBusy=false;
function setPing(value:number|null,title='Server round-trip time unavailable'){
  $('#ping-value').textContent=value===null?'—':String(Math.max(1,Math.round(value)));
  $('#ping-label').title=title;$('#ping-label').dataset.quality=value===null?'offline':value>180?'slow':'good';
}
async function measurePing(){
  if(document.hidden)return;
  if(socket?.readyState===WebSocket.OPEN&&myId){
    if(pendingPing){if(performance.now()-pendingPing.started<5000)return;setPing(null,'Game server response timed out');}
    pendingPing={socket,nonce:++pingNonce,started:performance.now()};
    socket.send(JSON.stringify({type:'ping',nonce:pendingPing.nonce}));return;
  }
  pendingPing=null;if(httpPingBusy)return;httpPingBusy=true;
  const start=performance.now();
  try{const response=await fetch('/api/ping',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Unavailable');await response.json();if(!myId)setPing(performance.now()-start,'Server HTTP round-trip time · live hunts use the game WebSocket');}
  catch{if(!myId)setPing(null);}
  finally{httpPingBusy=false;}
}
setInterval(()=>void measurePing(),3000);void measurePing();
startNavigationHUD(game,()=>game.exploring?game.world.spawn:state.players.find(player=>player.id===myId)?.base);
async function connectWallet(enter=false){if(connecting)return;if(!(config.configured??config.authConfigured)){showLaunch();return;}connecting=true;
  // A new wallet proof replaces the entire local identity, including its socket.
  // Ignore any older restore request that finishes while the wallet is signing.
  ++authRevision;sessionReady=false;leave();walletAddress='';collection=[];lastCollectionSize=0;
  $('#collection-count').textContent='0';$('#wallet-button span').textContent='Connect wallet';$('#enter-button').innerHTML=`${icon('wallet')}Connect to play ${icon('arrow-up-right')}`;$('#entry-note').textContent='Verify your wallet to enter the hunt';refreshIcons();
try{const w=window as any;walletProvider=w.phantom?.solana??w.solana??w.solflare;if(!walletProvider){modal('Bring your wallet.',`<p>Use a Solana wallet to verify your holdings. Install Phantom or Solflare, then return to the island.</p><div class="dialog-links"><a href="https://phantom.com/" target="_blank" rel="noopener noreferrer">Phantom ${icon('external-link')}</a><a href="https://solflare.com/" target="_blank" rel="noopener noreferrer">Solflare ${icon('external-link')}</a></div>`);return;}
  const connected=await walletProvider.connect();const address=connected.publicKey.toString();const challenge=await api('/api/auth/challenge',{wallet:address});const signed=await walletProvider.signMessage(new TextEncoder().encode(challenge.message),'utf8');const signature=btoa(String.fromCharCode(...new Uint8Array(signed.signature??signed)));const verified=await api('/api/auth/verify',{wallet:address,nonce:challenge.nonce,signature});
  if(verified.player?.wallet!==address)throw new Error('Wallet verification returned a different account. Please reconnect.');
  walletAddress=address;sessionReady=true;collection=verified.collection??[];$('#collection-count').textContent=String(collection.length);$('#wallet-button span').textContent=walletAddress.slice(0,4)+'…'+walletAddress.slice(-4);$('#enter-button').innerHTML=`${icon('compass')}Enter the wilds ${icon('arrow-up-right')}`;$('#entry-note').textContent=`${Number(verified.player?.holdPercent??0).toFixed(3)}% held · Ownership verified`;refreshIcons();community.refreshSession();if(enter)join();else toast('Wallet verified. Your expedition is ready.');
}catch(error){toast(error instanceof Error?error.message:'Wallet connection was cancelled.')}finally{connecting=false}}
function showLaunch(){modal('Ready for the first drop.',`<p>The island is open to explore. Live entry unlocks when the game token and reward treasury are configured.</p><div class="launch-check"><span>${icon('check')}3D island & extraction rules</span><span>${icon('check')}Wallet ownership verification</span><span>${icon('lock-keyhole')}Pump game-token mint</span><span>${icon('lock-keyhole')}Funded treasury & card provider</span></div><p class="small-muted">The $CARDS payment token is separate from the game token you will hold. Entry requires at least 0.25% of the game token supply. No funds or rewards are simulated.</p><button class="primary-button" id="explore-modal">Explore the island ${icon('compass')}</button>`);$('#explore-modal').onclick=()=>{$('#modal').close();void exploreIsland()};refreshIcons()}
$('#wallet-button').onclick=()=>connectWallet();$('#enter-button').onclick=()=>!(config.configured??config.authConfigured)?void exploreIsland():sessionReady?join():void connectWallet(true);$('#explore-button').onclick=()=>void exploreIsland();
function join(){
  if(!sessionReady)return;
  if(socket&&(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING))return;
  const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);socket=ws;
  ws.onopen=()=>{if(socket===ws)ws.send(JSON.stringify({type:'join',name:walletAddress.slice(0,4)+'…'+walletAddress.slice(-4),character:game.variant}));};
  ws.onmessage=e=>{
    if(socket!==ws)return;
    const m=JSON.parse(e.data);
    if(m.type==='community'){community.receive(m);return;}
    if(m.type==='chat_ack'){community.ack(m);return;}
    if(m.type==='welcome'){
      if(game.exploring){game.leave();document.body.classList.remove('exploring');$('.exploration-hud').hidden=true;}
      myId=m.id;state=m.state;lastCollectionSize=state.players.find(p=>p.id===myId)?.collection?.length??0;
      game.setState(state);game.setPlaying(myId!);document.body.classList.add('playing');
      for(const el of document.querySelectorAll<HTMLElement>('.player-hud,.game-tools,.minimap,.touch-controls'))el.hidden=false;
      $('#perspective-button').setAttribute('aria-label','Capture mouse to look around');$('#perspective-button').title='Capture mouse to look around';
      $('#session-status').textContent='LIVE EXPEDITION';updateHUD();community.refreshSession();toast('Find a pack, then follow your base marker home. Right-click to grab or snatch.');
    }else if(m.type==='state'){state=m.state;game.setState(state);updateHUD();}
    else if(m.type==='action'){
      if(!m.ok){toast(m.reason||'Action unavailable');audio.denied();}
      else if(m.action==='ability'){audio.ability(m.ability);toast(m.ability==='radar'?'Pulse scan active for 8 seconds.':'Quickstep active for 8 seconds.');}
      else if(m.action==='picked_up'){audio.pickup();game.gesture('PickUp');}
      else if(m.action==='stolen'){audio.steal();game.gesture('Interact');}
    }else if(m.type==='error')toast(m.message||m.error||'Action unavailable');
    else if(m.type==='event')toast(m.text||m.message);
    else if(m.type==='pong'&&pendingPing?.socket===ws&&pendingPing.nonce===m.nonce){setPing(performance.now()-pendingPing.started,'Live game WebSocket round-trip time');pendingPing=null;}
  };
  ws.onclose=()=>{if(socket!==ws)return;if(myId)toast('Disconnected from the island. Reconnect your wallet to return.');leave(false);sessionReady=false;};
  ws.onerror=()=>{if(socket===ws)toast('Unable to join. Check your connection and verified holdings.');};
}
function send(message:unknown){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message))}
game.onMove=(x,z,yaw,sprinting)=>send({type:'move',x,z,yaw,sprinting});game.onInteract=()=>send({type:'interact'});game.onAbility=ability=>send({type:'ability',ability});game.onJump=()=>send({type:'jump'});
function leave(close=true){
  const prior=socket;socket=null;
  if(prior){prior.onopen=null;prior.onmessage=null;prior.onclose=null;prior.onerror=null;if(close&&prior.readyState<=WebSocket.OPEN)prior.close();}
  pendingPing=null;setPing(null);myId=null;game.leave();state={...state,players:[],packs:[],events:[]};document.body.classList.remove('playing','exploring');
  for(const el of document.querySelectorAll<HTMLElement>('.player-hud,.game-tools,.minimap,#interaction,.exploration-hud,.touch-controls'))el.hidden=true;
  $('#perspective-button').setAttribute('aria-label','Toggle character and island view');$('#perspective-button').title='Character / island view';
  $('#session-status').textContent='YOUR COLLECTOR';$('#footer-status').textContent=(config.configured??config.authConfigured)?'Wallet verification available':'Island ready · Token launch pending';syncCharacters();community.refreshSession();
}
$('#leave-button').onclick=()=>leave();$('#jump-button').onclick=()=>game.jump();$('#interact-button').onclick=()=>game.interact();$('#interaction').onclick=()=>game.interact();$('#radar-button').onclick=()=>game.activateAbility('radar');$('#dash-button').onclick=()=>game.activateAbility('dash');
let enteringExplore=false;
async function exploreIsland(){
  if(enteringExplore||game.exploring||myId)return;
  if(socket&&socket.readyState<=WebSocket.OPEN){toast('Finish joining the hunt before exploring.');return;}
  enteringExplore=true;
  try{
    await game.enterExplore();document.body.classList.add('playing','exploring');
    for(const el of document.querySelectorAll<HTMLElement>('.game-tools,.minimap,.exploration-hud,.touch-controls'))el.hidden=false;
    $('.player-hud').hidden=true;$('#interaction').hidden=true;
    $('#perspective-button').setAttribute('aria-label','Capture mouse to look around');$('#perspective-button').title='Capture mouse to look around';$('#session-status').textContent='EXPLORING';$('#footer-status').textContent='Island exploration · Walk freely';
    refreshExplorerMap();if(!matchMedia('(max-width:760px),(any-pointer:coarse)').matches)toast('WASD to walk. Hold Shift to sprint. Move your mouse to look; Escape releases the cursor.');
  }catch(error){toast(error instanceof Error?error.message:'The island could not load. Please retry.');}
  finally{enteringExplore=false;}
}
game.onExitExplore=()=>leave();
game.onExploreAction=action=>toast(action==='interact'?'Right-click to snatch when you are close to a rival carrying a pack in a live hunt.':'Join the holder hunt to use timed tools.');
game.onMouseCaptureChange=()=>{const hint=$('#camera-hint');hint.innerHTML=game.mouseLookMode==='captured'?'Move mouse to look · <kbd>ESC</kbd> Cursor':game.mouseLookMode==='hover'?'Move mouse · Hold near edge to keep turning · <kbd>ESC</kbd> Cursor':'Click island to look · <kbd>ESC</kbd> Return';};
game.onMouseCaptureError=()=>toast('Move your mouse to look. Hold near an island edge to keep turning. Adjust sensitivity in Settings.');
function refreshExplorerMap(){if(!game.controlling)return;if(game.exploring){const p=game.explorationPosition;$('#explorer-coordinates').textContent=`Position ${Math.round(p.x)}, ${Math.round(p.z)} · Return to the camp flag`; }drawMap($('#mini-canvas'),true);const large=document.querySelector<HTMLCanvasElement>('#large-map');if(large&&$('#modal').open)drawMap(large,false,document.querySelector<HTMLElement>('[data-district].selected')?.dataset.district??null);}
setInterval(refreshExplorerMap,100);
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-control]')){
  const code=button.dataset.control!;
  const release=()=>{game.setControl(code,false);button.classList.remove('held');};
  button.addEventListener('pointerdown',e=>{if(!game.controlling)return;e.preventDefault();button.setPointerCapture(e.pointerId);game.setControl(code,true);button.classList.add('held');});
  for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,release);
  button.addEventListener('keydown',e=>{if(e.code==='Space'||e.code==='Enter'){e.preventDefault();game.setControl(code,true);button.classList.add('held');}});
  button.addEventListener('keyup',release);button.addEventListener('blur',release);
}
let lastCollectionSize=0;function updateHUD(){const me=state.players.find(p=>p.id===myId);if(!me)return;$('#player-name').textContent=me.name;$('#player-tier').textContent=me.elite?'ELITE COLLECTOR':'HOLDER';$('#online-count').textContent=`${state.players.length} collectors`;
  const carried=state.packs.find(p=>p.id===me.carrying);$('#carry-status').innerHTML=me.carrying?`${icon('gem')}Carrying ${cash(carried?.tier)} pack<span>Return to your base · ${Math.round(Math.hypot(me.x-me.base.x,me.z-me.base.z))}m</span>`:`${icon('backpack')}Your hands are free<span>Search houses, trails, and ruins</span>`;
  $('#collection-count').textContent=String(me.collection?.length??me.score??0);for(const selector of ['#radar-button','#dash-button']){$<HTMLButtonElement>(selector).disabled=!me.elite;$<HTMLButtonElement>(selector).title=me.elite?'Timed tool. Cooldown enforced by the server.':'Hold more than 2% to unlock';}
  const near=state.packs.find(p=>p.status==='hidden'&&Math.hypot(me.x-p.x,me.z-p.z)<3.8);const rival=state.players.find(p=>p.id!==myId&&p.carrying&&Math.hypot(me.x-p.x,me.z-p.z)<3.5);$('#interaction').hidden=!!me.carrying||(!near&&!rival);$('#interaction span').textContent=near?'Pick up '+cash(near.tier)+' pack':'Steal carried pack';collection=me.collection??collection;if(collection.length>lastCollectionSize){if(lastCollectionSize||me.carrying===null){audio.deliver();game.gesture('Cheer');}lastCollectionSize=collection.length;}refreshIcons();}
function showGuide(){modal('Every pack has a journey.',`<p>Explore Verdant Isle, discover a funded pack, and return it to your base to secure its card. Until then, another collector can take it.</p><div class="guide-grid"><div><kbd>W A S D</kbd><strong>Move around</strong><span>Arrow keys work too</span></div><div><kbd>SHIFT</kbd><strong>Sprint</strong><span>Carrying a pack slows you down</span></div><div><kbd>SPACE</kbd><strong>Jump</strong><span>Release, then jump again after landing</span></div><div><kbd>RIGHT CLICK</kbd><strong>Grab / snatch</strong><span>Get close to a pack or carrier</span></div><div><kbd>MOUSE</kbd><strong>Look around</strong><span>Move the mouse · Drag on touch screens</span></div><div><kbd>Q</kbd><strong>Pulse scan</strong><span>Briefly reveal nearby hiding places</span></div><div><kbd>F</kbd><strong>Quickstep</strong><span>A short burst of extra speed</span></div></div><div class="note-box">${icon('shield-check')}Only delivery to your own base secures a reward. Tools require more than 2% holdings and have server-enforced cooldowns.</div>`)}
$('#how-button').onclick=showGuide;$('#support-button').onclick=showGuide;
$('#perks-button').onclick=()=>modal('An edge. A small window.',`<p>Collectors holding strictly more than 2% of the game token supply can activate timed tools. Your eligibility is checked by the server.</p><div class="perk-row">${icon('radio')}<div><h3>Pulse scan</h3><p>Expand your search radius briefly to reveal nearby packs. It does not reveal the entire island.</p></div><kbd>Q</kbd></div><div class="perk-row">${icon('zap')}<div><h3>Quickstep</h3><p>Gain a temporary speed boost. A cooldown keeps the chase competitive.</p></div><kbd>F</kbd></div><p class="small-muted">Holding more tokens never guarantees a card. You still have to find it and reach your base.</p>`);
function showTreasury(){const t=state.treasury;modal('The treasury fuels the hunt.',`<p>Confirmed creator fees fund real card packs. Drops adjust to available funds and recent fee income, while keeping a reserve for existing obligations.</p><div class="treasury-grid"><div><span>Available treasury</span><strong>${cash(t.balance)}</strong></div><div><span>Fees / 10 minutes</span><strong>${cash(t.fees10m)}</strong></div><div><span>Reserved for rewards</span><strong>${cash(t.reserved)}</strong></div></div><h3>Every drop earns its place</h3><ul class="rule-list"><li>$25, $50, and $100 packs form the regular pool.</li><li>$250 and $500 packs require stronger funding and high-tier cooldowns.</li><li>Decisions run on a 10-minute or hourly cadence.</li><li>Only purchased, confirmed cards enter the world.</li><li>High-value packs spawn in more remote, difficult locations.</li></ul><div class="note-box">${icon('lock-keyhole')}${t.ready?'Live treasury data. All purchases and rewards are recorded server-side.':'Treasury connection pending. No pack purchases or token transfers are enabled.'}</div>`)}
$('#drop-button').onclick=showTreasury;
function showCollection(){const me=state.players.find(p=>p.id===myId);const items=me?.collection??collection;modal('Your field collection.',items.length?`<p>Cards secured by returning packs to your base.</p><div class="collection-list">${items.map(p=>`<div>${icon('gem')}<strong>${esc(p.name||cash(p.value)+' card')}</strong><span>${p.status==='transferred'?'Delivered to wallet':p.status==='delivery_quarantined'?'Transfer paused for verification':'Wallet transfer · Auto-retrying'}${p.status!=='transferred'&&p.reason?`<small>${esc(p.reason)}</small>`:''}${p.status==='pending_transfer'&&p.nextAttemptAt?`<small>Next check ${esc(new Date(p.nextAttemptAt).toLocaleTimeString())}</small>`:''}${p.signature?` · <a href="https://solscan.io/tx/${encodeURIComponent(p.signature)}" target="_blank" rel="noopener noreferrer">View transfer</a>`:''}</span></div>`).join('')}</div>`:`<div class="empty-state">${icon('backpack')}<h3>Your next grail is out there.</h3><p>${sessionReady?'Enter the island and return a pack to your base to start your collection.':'Connect an eligible wallet to view your secured cards.'}</p></div>`)}
for(const button of document.querySelectorAll<HTMLElement>('[data-tab]'))button.onclick=()=>{const tab=button.dataset.tab;if(tab==='collection')showCollection();else if(tab==='treasury')showTreasury();else community.navigate(tab==='leaderboard'?'/leaderboard':'/');};
$('.brand').onclick=event=>{event.preventDefault();community.navigate('/');};
function drawMap(canvas:HTMLCanvasElement,small=false,selectedDistrict:string|null=null){drawIslandMap(canvas,{background:game.mapSnapshot(),landmarks:game.world.landmarks,players:game.exploring?[]:state.players,myId:game.exploring?null:myId,small,selectedDistrict,localPosition:myId?game.explorationPosition:undefined,explorer:game.exploring?game.explorationPosition:undefined,explorerCamp:game.exploring?{x:game.world.spawn.x,z:game.world.spawn.z}:undefined})}
$('#map-button').onclick=()=>{modal('VERDANT ISLE',`<p>Your field map. Pick a district to plan your next hunt.</p><div class="map-layout"><canvas id="large-map" class="large-map" width="900" height="900" aria-label="Detailed map of Verdant Isle"></canvas><div class="district-list">${DISTRICT_INFO.map(d=>`<button data-district="${d.id}"><span>${d.number}</span><div><strong>${d.name}</strong><small>${d.subtitle}</small></div></button>`).join('')}<div class="district-details" id="district-details">Select a district to learn the terrain. Pack locations stay hidden until you discover them.</div></div></div><div class="map-legend"><span><i></i>Your position</span>${game.exploring?'':'<span>⌂ Your base</span>'}<span>${game.exploring?'Follow the trails to discover the island':'Packs stay hidden until discovered'}</span></div>`);$('#modal').classList.add('map-dialog');drawMap($('#large-map'));for(const b of document.querySelectorAll<HTMLElement>('[data-district]'))b.onclick=()=>{const d=DISTRICT_INFO.find(d=>d.id===b.dataset.district)!;drawMap($('#large-map'),false,d.id);$('#district-details').textContent=d.description;for(const o of document.querySelectorAll('[data-district]'))o.classList.toggle('selected',o===b);};};
$('.minimap').onclick=()=>$('#map-button').click();$('.minimap').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('#map-button').click();}};
$('#settings-button').onclick=()=>{modal('Make yourself at home.',`<p>Tune your camera, sound, and graphics.</p><div class="setting-row sensitivity-setting"><div><strong>Look sensitivity</strong><p>Mouse and touch camera speed</p></div><div class="sensitivity-control"><output id="sensitivity-value">${game.getSensitivity().toFixed(2)}×</output><input type="range" id="sensitivity-slider" min="0.25" max="3" step="0.05" value="${game.getSensitivity()}" aria-label="Look sensitivity"/></div></div><div class="setting-row"><div><strong>Detailed shadows</strong><p>Sharper scenery, higher GPU usage</p></div><input type="checkbox" id="quality-toggle" aria-label="Detailed shadows" ${game.quality?'checked':''}/></div><div class="setting-row"><div><strong>Sound effects</strong><p>Footsteps, pickups, steals & celebrations</p></div><input type="checkbox" id="sound-toggle" aria-label="Sound effects" ${audio.enabled?'checked':''}/></div><div class="setting-row"><div><strong>Camera orbit</strong><p>Slowly rotate character selection</p></div><input type="checkbox" id="orbit-toggle" aria-label="Camera orbit" ${game.controls.autoRotate?'checked':''}/></div><p class="small-muted">Desktop keyboard and mouse recommended for competitive play.</p>`);$('#sensitivity-slider').oninput=e=>{game.setSensitivity(Number((e.target as HTMLInputElement).value));$('#sensitivity-value').textContent=game.getSensitivity().toFixed(2)+'×';};$('#sound-toggle').onchange=e=>{audio.setEnabled((e.target as HTMLInputElement).checked);updateSoundButton();};$('#quality-toggle').onchange=e=>game.setQuality((e.target as HTMLInputElement).checked);$('#orbit-toggle').onchange=e=>game.controls.autoRotate=(e.target as HTMLInputElement).checked;};
$('#fullscreen-button').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.')}};

$('#perspective-button').onclick=()=>{if(game.controlling){void game.capturePointer();return;}game.toggleOverview();$('.world-location h2').textContent=game.overview?'EXPLORE VERDANT ISLE':'YOUR ADVENTURE STARTS HERE!';$('.world-location .eyebrow').textContent=game.overview?'A WORLD WORTH GETTING LOST IN':'YOUR CHARACTER. YOUR EXPEDITION.';};

function syncCharacters(){$('.world-location h2').textContent=CHARACTER_OPTIONS.find(o=>o.id===game.variant)!.name.toUpperCase();for(const b of document.querySelectorAll<HTMLElement>('[data-character]')){b.classList.toggle('selected',b.dataset.character===game.variant);b.onclick=()=>{if(game.playing)return;game.selectCharacter(b.dataset.character as CharacterVariant);$('.world-location h2').textContent=CHARACTER_OPTIONS.find(o=>o.id===game.variant)!.name.toUpperCase();syncCharacters()}}}
$('#character-cheer').onclick=()=>{game.gesture('Cheer');audio.deliver()};
function updateSoundButton(){const b=$('#sound-button');b.title=audio.enabled?'Sound effects on':'Sound effects off';b.setAttribute('aria-label',audio.enabled?'Mute sound effects':'Enable sound effects');b.classList.toggle('muted',!audio.enabled)}
$('#sound-button').onclick=()=>{audio.setEnabled(!audio.enabled);updateSoundButton()};updateSoundButton();
document.addEventListener('pointerdown',async e=>{await audio.unlock();if((e.target as HTMLElement).closest('button'))audio.click()},{capture:true});
async function restoreSession(){const revision=authRevision;try{const session=await api('/api/auth/session');if(session.ok&&revision===authRevision&&!connecting){sessionReady=true;walletAddress=session.player.wallet;collection=session.collection??[];$('#collection-count').textContent=String(collection.length);$('#wallet-button span').textContent=walletAddress.slice(0,4)+'…'+walletAddress.slice(-4);$('#enter-button').innerHTML=`${icon('compass')}LET'S PLAY! ${icon('arrow-up-right')}`;refreshIcons();community.refreshSession();}}catch{}}restoreSession();
