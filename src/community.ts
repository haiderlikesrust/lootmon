import type { ChatMessage, CommunityState, IslandActivity, LeaderboardState } from './types';

type Session = { wallet:string|null; canChat:boolean; connected:boolean };
type Options = {host:HTMLElement;getSession:()=>Session;send:(text:string)=>void;onFocus:()=>void;onRoute:(leaderboard:boolean)=>void};
const portrait='/art/looter-avatar.png';
const money=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number.isFinite(value)?value:0);
const short=(value:string)=>`${value.slice(0,5)}…${value.slice(-5)}`;
const signatureValid=(value:unknown):value is string=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value);
const timeValid=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000;
const stamp=(time:number)=>new Date(time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
function node<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text=''){const element=document.createElement(tag);element.className=className;if(text)element.textContent=text;return element;}
function button(className:string,text:string,action:()=>void){const element=node('button',className,text);element.type='button';element.addEventListener('click',action);return element;}
function avatar(className=''){const img=node('img',`looter-avatar ${className}`);img.src=portrait;img.alt='Looter';img.width=48;img.height=48;return img;}
async function copyText(value:string){await navigator.clipboard.writeText(value);}
function copyButton(value:string,label:string){const control=button('community-copy','Copy',()=>{void copyText(value).then(()=>{control.textContent='Copied';setTimeout(()=>{control.textContent='Copy';},1500);}).catch(()=>{control.textContent='Select below';details.open=true;});});control.title=label;control.setAttribute('aria-label',label);const details=node('details','community-reference');const summary=node('summary','','Full transaction');const code=node('code','',value);details.append(summary,code);return {control,details};}
function transaction(signature:unknown){
  if(!signatureValid(signature))return null;
  const group=node('div','community-transaction');const link=node('a','','View transaction ↗');link.href=`https://solscan.io/tx/${encodeURIComponent(signature)}`;link.target='_blank';link.rel='noopener noreferrer';link.title=signature;
  const copy=copyButton(signature,'Copy full confirmed transaction signature');group.append(link,copy.control,copy.details);return group;
}
function validMessage(value:unknown):value is ChatMessage {if(!value||typeof value!=='object')return false;const m=value as ChatMessage;return typeof m.id==='string'&&['player','bot'].includes(m.kind)&&typeof m.name==='string'&&typeof m.text==='string'&&timeValid(m.time);}
function validActivity(value:unknown):value is IslandActivity {if(!value||typeof value!=='object')return false;const m=value as IslandActivity;return typeof m.id==='string'&&['pickup','stolen','deposit','win','opening','opened','spawned'].includes(m.kind)&&typeof m.name==='string'&&Number.isFinite(m.tier)&&timeValid(m.time);}

export function createCommunityUI(options:Options){
  const dock=node('section','community-dock');dock.setAttribute('aria-label','Island chat');
  let preference:boolean|null=null;
  try{const saved=localStorage.getItem('lootmon-chat-open');if(saved==='true'||saved==='false')preference=saved==='true';}catch{}
  let open=preference??false,unread=0,loaded=false,seen=new Set<string>(),publicBusy=false,dataRevision=0,pendingTimer=0,pendingText='';
  let chat:ChatMessage[]=[],activity:IslandActivity[]=[],historyOpen=false,leaderboardOpen=false,boardRevision=0,boardBusy=false;
  const toggle=button('community-toggle','',()=>setOpen(!open,true));toggle.id='community-toggle';toggle.append(avatar(),node('span','','ISLAND CHAT'));const unreadBadge=node('b','community-unread');unreadBadge.hidden=true;toggle.append(unreadBadge);toggle.setAttribute('aria-controls','island-chat-panel');
  const panel=node('div','community-panel');panel.id='island-chat-panel';
  const header=node('div','community-heading'),headingText=node('div','community-heading-label');headingText.append(node('strong','','ISLAND CHAT'),node('small','','LOOTER IS ON WATCH'));
  const connection=node('span','community-connection','PUBLIC');
  const boardButton=button('community-icon-button','♜',()=>navigate('/leaderboard'));boardButton.title='View leaderboard';boardButton.setAttribute('aria-label','View leaderboard');
  const hide=button('community-icon-button','−',()=>setOpen(false,true));hide.title='Hide chat';hide.setAttribute('aria-label','Hide chat');header.append(avatar(),headingText,connection,boardButton,hide);
  const messages=node('div','community-messages');messages.id='community-messages';messages.setAttribute('role','log');messages.setAttribute('aria-live','polite');messages.setAttribute('aria-relevant','additions');
  const form=node('form','community-composer'),input=node('input','community-input');input.id='community-chat-input';input.type='text';input.maxLength=240;input.autocomplete='off';input.placeholder='Message the island…';input.setAttribute('aria-label','Message island chat');
  const submit=node('button','community-send','↵');submit.type='submit';submit.title='Send message';submit.setAttribute('aria-label','Send message');form.append(input,submit);
  const hint=node('p','community-hint','Join a verified live hunt to send messages.');hint.setAttribute('role','status');
  const commands=node('div','community-commands');for(const command of ['/help','/rules','/base','/drops','/leaderboard'])commands.append(button('',command,()=>{if(!options.getSession().canChat)return;options.onFocus();input.value=command;input.focus();}));
  panel.append(header,messages,form,commands,hint);dock.append(toggle,panel);options.host.append(dock);

  const feed=node('section','activity-feed');feed.setAttribute('aria-label','Recent island activity');
  const activityToggle=button('activity-toggle','',()=>{historyOpen=!historyOpen;renderActivity();});activityToggle.append(node('span','','✦ ISLAND ACTIVITY'));const activityCount=node('span','activity-count','Waiting for a drop');activityToggle.append(activityCount);
  const activityList=node('ol','activity-list');feed.append(activityToggle,activityList);options.host.append(feed);

  const board=node('section','leaderboard-page-shell');board.id='leaderboard-page';board.hidden=true;board.setAttribute('aria-labelledby','leaderboard-title');
  const inner=node('div','leaderboard-inner'),hero=node('header','leaderboard-hero'),heroText=node('div');
  const back=button('leaderboard-back','← BACK TO THE ISLAND',()=>navigate('/'));heroText.append(back,node('span','leaderboard-eyebrow','VERDANT ISLE · THE COLLECTORS'));
  const title=node('h1','','THE LOOT BOARD');title.id='leaderboard-title';heroText.append(title,node('p','leaderboard-intro','Find it. Get it home. Make your mark. Confirmed wallet deliveries earn a place on the board.'));
  const looter=node('div','leaderboard-looter');looter.append(avatar(),node('strong','','LOOTER VERIFIED'),node('span','','Every win has a receipt.'));hero.append(heroText,looter);
  const summary=node('div','leaderboard-stats');
  const collectorStat=node('strong','','—'),winStat=node('strong','','—'),valueStat=node('strong','','—');
  for(const [label,value] of [['COLLECTORS RANKED',collectorStat],['CONFIRMED WINS · THIS BOARD',winStat],['CARD VALUE · THIS BOARD',valueStat]] as const){const stat=node('div');stat.append(node('span','',label),value);summary.append(stat);}
  const boardHeading=node('div','leaderboard-list-heading');boardHeading.append(node('h2','','ISLAND LEGENDS'));const updated=node('span','','Loading results…');const refresh=button('leaderboard-refresh','↻ Refresh',()=>void refreshBoard(true));boardHeading.append(updated,refresh);
  const results=node('div','leaderboard-results');results.setAttribute('aria-live','polite');
  const explanation=node('p','leaderboard-note','Wins count confirmed transfers. Secured packs awaiting delivery appear as pending. Recorded card values are not guaranteed resale prices.');inner.append(hero,summary,boardHeading,results,explanation);board.append(inner);document.querySelector('#app')!.append(board);

  function setOpen(value:boolean,persist=false){open=value;if(persist){preference=value;try{localStorage.setItem('lootmon-chat-open',String(value));}catch{}}panel.hidden=!value;toggle.hidden=value;toggle.setAttribute('aria-expanded',String(value));document.body.classList.toggle('community-chat-open',value);if(value){unread=0;unreadBadge.hidden=true;messages.scrollTop=messages.scrollHeight;}else input.blur();}
  function refreshSession(){
    const session=options.getSession();input.disabled=!session.canChat;submit.disabled=!session.canChat||!!pendingTimer;connection.textContent=session.connected?'LIVE':'PUBLIC';connection.classList.toggle('connected',session.connected);
    if(!session.canChat){hint.textContent='Join a verified live hunt to send messages.';if(pendingTimer){clearTimeout(pendingTimer);pendingTimer=0;}}
    else if(!pendingTimer)hint.textContent='Enter to send · Esc to leave chat · /help for Looter';
    if(preference===null){const desired=session.canChat&&!matchMedia('(max-width:760px),(any-pointer:coarse)').matches;if(desired!==open)setOpen(desired);}
    commands.hidden=!session.canChat;
  }
  input.addEventListener('focus',()=>{options.onFocus();});
  input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();input.blur();options.onFocus();}});
  input.addEventListener('keyup',event=>event.stopPropagation());
  form.addEventListener('submit',event=>{event.preventDefault();const text=input.value.trim();if(!text||pendingTimer)return;if(!options.getSession().canChat){refreshSession();return;}pendingText=text;options.send(text);submit.disabled=true;hint.textContent='Sending…';pendingTimer=window.setTimeout(()=>{pendingTimer=0;submit.disabled=!options.getSession().canChat;hint.textContent='No reply yet. Your message is kept here so you can retry.';},6000);});
  function ack(message:{ok:boolean;reason?:string}){if(pendingTimer)clearTimeout(pendingTimer);pendingTimer=0;submit.disabled=!options.getSession().canChat;if(message.ok){if(input.value.trim()===pendingText)input.value='';hint.textContent='Enter to send · Esc to leave chat · /help for Looter';}else hint.textContent=typeof message.reason==='string'?message.reason:'Message could not be sent.';pendingText='';}
  function renderMessages(){
    const atBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<45,oldScroll=messages.scrollTop;
    messages.replaceChildren();
    if(!chat.length){const empty=node('div','community-empty');empty.append(node('strong','','The island is quiet.'),node('span','','Player messages and confirmed wins appear here.'));messages.append(empty);return;}
    for(const message of chat){
      const row=node('article',`chat-message ${message.kind==='bot'?'chat-bot':''}`);
      if(message.kind==='bot')row.append(avatar());else row.append(node('span','chat-player-avatar',message.name.slice(0,2).toUpperCase()));
      const content=node('div','chat-message-content'),meta=node('div','chat-message-meta');meta.append(node('strong','',message.kind==='bot'?'Looter':message.name));if(message.kind==='bot')meta.append(node('span','chat-bot-tag','BOT'));const time=node('time','',stamp(message.time));time.dateTime=new Date(message.time).toISOString();meta.append(time);
      const text=message.kind==='bot'&&signatureValid(message.signature)&&message.text.endsWith(` TX: ${message.signature}`)?message.text.slice(0,-(` TX: ${message.signature}`).length):message.text;
      content.append(meta,node('p','chat-text',text));if(message.kind==='bot'){const tx=transaction(message.signature);if(tx)content.append(tx);}row.append(content);messages.append(row);
    }
    if(atBottom||!loaded)messages.scrollTop=messages.scrollHeight;else messages.scrollTop=oldScroll;
  }
  function renderActivity(){
    feed.classList.toggle('expanded',historyOpen);activityToggle.setAttribute('aria-expanded',String(historyOpen));activityCount.textContent=activity.length?`${historyOpen?'Close history':'Last '+Math.min(3,activity.length)} ${historyOpen?'−':'+'}`:'Waiting for a drop';
    activityList.replaceChildren();activityList.hidden=!activity.length;
    for(const item of activity.slice(0,historyOpen?15:3)){
      const row=node('li',`activity-${item.kind}`),mark=node('span','activity-mark',({pickup:'◇',stolen:'↯',deposit:'⌂',win:'★',opening:'◌',opened:'✦',spawned:'◇'})[item.kind]);
      const text=node('span','activity-text'),name=node('strong','',item.name);if(item.kind==='opening'||item.kind==='opened'||item.kind==='spawned'){text.textContent=item.text??`Looter is opening a ${money(item.tier)} pack…`;}else{text.append(name,document.createTextNode(` ${{pickup:'picked up',stolen:'snatched',deposit:'secured',win:'received'}[item.kind]} a ${money(item.tier)} pack`));}
      row.append(mark,text);if(historyOpen){const time=node('time','',stamp(item.time));time.dateTime=new Date(item.time).toISOString();row.append(time);const tx=transaction(item.signature);if(tx)row.append(tx);}activityList.append(row);
    }
  }
  function receive(payload:unknown){
    if(!payload||typeof payload!=='object')return;const data=payload as Partial<CommunityState>;if(!Array.isArray(data.chat)||!Array.isArray(data.activity))return;
    dataRevision++;chat=data.chat.filter(validMessage).slice(-100);activity=data.activity.filter(validActivity).slice(0,30);
    if(loaded&&!open){unread+=chat.filter(message=>!seen.has(message.id)).length;unreadBadge.textContent=unread>99?'99+':String(unread);unreadBadge.hidden=!unread;}
    seen=new Set(chat.map(message=>message.id));renderMessages();renderActivity();loaded=true;refreshSession();
  }
  async function refreshPublic(){
    if(document.hidden||options.getSession().connected||publicBusy)return;publicBusy=true;const revision=dataRevision;
    try{const response=await fetch('/api/community',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error();const data=await response.json();if(revision===dataRevision&&!options.getSession().connected)receive(data);}
    catch{connection.textContent='OFFLINE';if(!loaded){messages.replaceChildren(node('div','community-empty','Island chat is reconnecting.'));}}
    finally{publicBusy=false;}
  }
  function showBoardNotice(title:string,detail:string,error=false){results.replaceChildren();const empty=node('div',`leaderboard-empty${error?' error':''}`);empty.append(node('span','leaderboard-empty-icon',error?'!':'◇'),node('h3','',title),node('p','',detail));results.append(empty);}
  function renderBoard(data:LeaderboardState){
    const entries=data.entries.filter(entry=>entry&&typeof entry.wallet==='string'&&typeof entry.name==='string'&&[entry.rank,entry.wins,entry.totalValue,entry.secured,entry.pending].every(Number.isFinite)).slice(0,100);
    collectorStat.textContent=String(data.totalCollectors);winStat.textContent=String(entries.reduce((sum,entry)=>sum+entry.wins,0));valueStat.textContent=money(entries.reduce((sum,entry)=>sum+entry.totalValue,0));updated.textContent=`Updated ${stamp(data.updatedAt)}`;
    if(!entries.length){showBoardNotice('Your legend starts with one pack.','No collectors have secured a reward yet. The first confirmed wins will appear here.');return;}
    const table=node('table','leaderboard-table');const head=node('thead'),headRow=node('tr');for(const label of ['RANK','COLLECTOR','WINS','CARD VALUE','STATUS'])headRow.append(node('th','',label));head.append(headRow);table.append(head);const body=node('tbody');
    for(const entry of entries){
      const row=node('tr',`leaderboard-row rank-${entry.rank}${entry.wallet===options.getSession().wallet?' is-you':''}`);const rank=node('td','leaderboard-rank',entry.rank<4?['','①','②','③'][entry.rank]:String(entry.rank));
      const collector=node('td','leaderboard-collector'),badge=node('span',`collector-avatar character-${['scout','ranger','sage'].includes(entry.character)?entry.character:'scout'}`,entry.name.slice(0,2).toUpperCase());const identity=node('div');const name=node('strong','',entry.name);if(entry.wallet===options.getSession().wallet)name.append(node('small','you-tag','YOU'));const wallet=node('button','leaderboard-wallet',short(entry.wallet));wallet.type='button';wallet.title=`Copy wallet ${entry.wallet}`;wallet.addEventListener('click',()=>{void copyText(entry.wallet).then(()=>{wallet.textContent='Wallet copied';setTimeout(()=>{wallet.textContent=short(entry.wallet);},1800);}).catch(()=>{wallet.textContent=entry.wallet;});});identity.append(name,wallet);collector.append(badge,identity);
      const wins=node('td','leaderboard-wins',String(entry.wins)),value=node('td','leaderboard-value',money(entry.totalValue)),status=node('td','leaderboard-status');status.append(node('span',entry.online?'collector-online':'collector-offline',entry.online?'ON THE ISLAND':'OFFLINE'),node('small','',`${entry.secured} secured${entry.pending?` · ${entry.pending} pending`:''}`));row.append(rank,collector,wins,value,status);body.append(row);
    }
    table.append(body);results.replaceChildren(table);
  }
  async function refreshBoard(force=false){
    if(!leaderboardOpen||boardBusy&&!force)return;const revision=++boardRevision;boardBusy=true;refresh.disabled=true;
    if(!results.childElementCount)showBoardNotice('Reading the island ledger…','Fetching real collector standings.');
    try{const response=await fetch('/api/leaderboard',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error();const data=await response.json();if(!Array.isArray(data.entries)||!Number.isFinite(data.totalCollectors)||!Number.isFinite(data.updatedAt))throw new Error();if(revision===boardRevision&&leaderboardOpen)renderBoard(data);}
    catch{if(revision===boardRevision&&leaderboardOpen){showBoardNotice('The board is taking a breather.','Standings could not be loaded. Use Refresh to try again.',true);updated.textContent='Connection unavailable';}}
    finally{if(revision===boardRevision){boardBusy=false;refresh.disabled=false;}}
  }
  function applyRoute(){
    leaderboardOpen=location.pathname.replace(/\/$/,'')==='/leaderboard';board.hidden=!leaderboardOpen;document.body.classList.toggle('leaderboard-page',leaderboardOpen);document.title=leaderboardOpen?'Loot Board · Lootmon':'Lootmon — Verdant Isle';options.onFocus();options.onRoute(leaderboardOpen);
    if(leaderboardOpen){input.blur();void refreshBoard(true);board.scrollTop=0;}else{boardRevision++;boardBusy=false;}
  }
  function navigate(path:'/'|'/leaderboard'){if(location.pathname!==path)history.pushState({},'',path);applyRoute();}
  window.addEventListener('popstate',applyRoute);
  setOpen(open);refreshSession();renderMessages();renderActivity();applyRoute();void refreshPublic();
  setInterval(()=>{refreshSession();void refreshPublic();if(leaderboardOpen&&!document.hidden)void refreshBoard();},10_000);
  return {receive,ack,refreshSession,navigate};
}
