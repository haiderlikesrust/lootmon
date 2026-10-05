import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCharacter, loadCharacters, type CharacterInstance, type CharacterVariant } from './characters';
import { createWorld } from './world';
import { accelerateCameraGeometry } from './camera-geometry';
import { collidesWithWorld } from '../shared/collision-index.mjs';
import type {GameState, Player} from './types';

const COLORS:Record<number,number>={25:0xc8ed8a,50:0x72dccc,100:0x8eabff,250:0xd18bfa,500:0xffcf75};
const JUMP_DURATION_MS=800;
const JUMP_RECOVERY_MS=120;
const JUMP_PEAK=1.5;
type JumpState={jumpStartedAt?:number;jumpUntil?:number;jumpReadyAt?:number};
export class Game {
  renderer:THREE.WebGLRenderer; scene=new THREE.Scene(); camera=new THREE.PerspectiveCamera(48,1,.2,700);
  controls:OrbitControls; world:ReturnType<typeof createWorld>; clock=new THREE.Clock();
  state:GameState|null=null; id:string|null=null; playing=false; exploring=false; keys=new Set<string>();
  avatarMeshes=new Map<string,THREE.Group>(); packMeshes=new Map<string,THREE.Group>(); bases=new Map<string,THREE.Group>();
  pos=new THREE.Vector3(0,0,22); angle=.58; yaw=0; lastSend=0; elapsed=0; quality=true; aim=new THREE.Vector3(); lobbyAvatar=new THREE.Group(); overview=false; ready:Promise<void>; characters=new Map<string,CharacterInstance>(); lobbyCharacter:CharacterInstance|null=null; variant:CharacterVariant='scout'; onStep:(sprinting:boolean)=>void=()=>{}; private mapImage:HTMLCanvasElement|null=null; private cameraRay=new THREE.Raycaster(); private cameraObstacles:THREE.Object3D[]=[];
  onMove:(x:number,z:number,yaw:number,sprinting:boolean)=>void=()=>{}; onInteract:()=>void=()=>{}; onAbility:(name:string)=>void=()=>{};
  onJump:()=>void=()=>{};
  onExitExplore:()=>void=()=>{};
  onExploreAction:(action:'interact'|'radar'|'dash')=>void=()=>{};
  onMouseCaptureChange:(captured:boolean)=>void=()=>{};
  onMouseCaptureError:(message:string)=>void=()=>{};
  private movementInput=new THREE.Vector2();
  private dragPointerId:number|null=null;
  private dragY=0;
  private cameraPitch=.52;
  private cameraDistance=10;
  private renderedAngle=.58;
  private renderedPitch=.52;
  private renderedDistance=10;
  private sensitivity=1;
  private lookTurnPending=false;
  private headingDirection=new THREE.Vector3();
  private lastHeading=0;
  private continuousHeading=0;
  private headingInitialized=false;
  private measuredFps=0;
  private fpsSampleStartedAt=0;
  private fpsSampleFrames=0;
  private pointerLockWanted=false;
  private pointerLockPending=false;
  private wasMouseCaptured=false;
  private hoverLook=false;
  private hoverPointer:THREE.Vector2|null=null;
  private escapeReleaseUntil=0;
  private localJumpStartedAt=0;
  private localJumpUntil=0;
  private localJumpReadyAt=0;
  private jumpPending=false;
  private visualJumpHeight=0;
  private serverClockOffset=0;
  private serverClockKnown=false;
  private cameraDesired=new THREE.Vector3();
  private cameraDirection=new THREE.Vector3();
  private cameraHits:THREE.Intersection[]=[];
  private avatarTarget=new THREE.Vector3();
  constructor(public host:HTMLElement){
    try{const saved=localStorage.getItem('lootmon-mouse-sensitivity');if(saved!==null&&Number.isFinite(Number(saved)))this.sensitivity=THREE.MathUtils.clamp(Number(saved),.25,3);}catch{}
    this.renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.18;
    host.appendChild(this.renderer.domElement);this.scene.background=new THREE.Color('#9bd9ed');this.scene.fog=new THREE.Fog('#a9d6d9',140,340);
    this.scene.add(new THREE.HemisphereLight(0xd5f5ff,0x8b9c69,2.1));
    const sun=new THREE.DirectionalLight(0xffe0ad,3.25);sun.position.set(-70,105,40);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-135,right:135,top:135,bottom:-135,near:1,far:290});sun.shadow.bias=-.0005;sun.shadow.normalBias=.08;this.scene.add(sun);
    this.world=createWorld(this.scene);this.cameraObstacles=[...this.scene.children].filter(o=>o instanceof THREE.Mesh||o instanceof THREE.Group);accelerateCameraGeometry(this.cameraObstacles);this.cameraRay.firstHitOnly=true;this.pos.copy(this.world.spawn);this.ready=loadCharacters().then(()=>{let saved: string|null=null;try{saved=localStorage.getItem('cards-character')}catch{}this.selectCharacter(['scout','ranger','sage'].includes(saved??'')?saved as CharacterVariant:'scout');});this.lobbyAvatar.position.copy(this.pos);this.lobbyAvatar.rotation.y=.45;this.scene.add(this.lobbyAvatar);this.camera.position.set(this.pos.x+4.8,3.5,this.pos.z+7);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.target.set(this.pos.x,1.3,this.pos.z);this.controls.enableDamping=true;this.controls.dampingFactor=.04;this.controls.minDistance=5;this.controls.maxDistance=200;this.controls.maxPolarAngle=Math.PI*.46;this.controls.minPolarAngle=.2;this.controls.autoRotate=false;this.controls.autoRotateSpeed=.16;this.controls.enablePan=true;this.controls.update();
    const resize=()=>{this.camera.aspect=host.clientWidth/host.clientHeight;this.camera.updateProjectionMatrix();this.renderer.setSize(host.clientWidth,host.clientHeight)};new ResizeObserver(resize).observe(host);resize();
    window.addEventListener('keydown',e=>{
      if(!this.controlling)return;
      if(this.inputBlocked()){this.releasePointer();return;}
      if(e.code==='Escape'){
        if(e.repeat)return;
        if(this.mouseCaptured||this.wasMouseCaptured||this.hoverLook||this.pointerLockPending){e.preventDefault();this.escapeReleaseUntil=performance.now()+250;this.releasePointer();return;}
        // Browsers may fire pointerlockchange before delivering the Escape
        // keydown that caused it. That first key must only free the cursor.
        if(performance.now()<this.escapeReleaseUntil){e.preventDefault();return;}
        if(this.exploring){e.preventDefault();this.leaveExplore();return;}
      }
      this.setControl(e.code,true);
      if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
      if(!e.repeat){if(e.code==='Space')this.jump();if(e.code==='KeyQ')this.activateAbility('radar');if(e.code==='KeyF')this.activateAbility('dash');}
    });
    window.addEventListener('keyup',e=>{this.keys.delete(e.code);if(e.code==='Escape')this.escapeReleaseUntil=0;});
    window.addEventListener('blur',()=>this.releasePointer());
    window.addEventListener('pointercancel',()=>this.clearInput());
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.releasePointer();});
    const canvas=this.renderer.domElement;
    document.addEventListener('pointerlockchange',()=>{
      const captured=this.mouseCaptured;
      this.pointerLockPending=false;
      if(captured&&(!this.pointerLockWanted||!this.controlling||this.inputBlocked())){document.exitPointerLock();return;}
      if(this.wasMouseCaptured&&!captured){this.escapeReleaseUntil=performance.now()+250;this.pointerLockWanted=false;this.angle=this.renderedAngle;this.cameraPitch=this.renderedPitch;this.clearInput();}
      this.wasMouseCaptured=captured;
      this.hoverLook=false;this.hoverPointer=null;
      canvas.style.cursor=captured?'none':'';
      this.onMouseCaptureChange(captured);
    });
    document.addEventListener('pointerlockerror',()=>this.captureFailed('This browser did not allow mouse capture.'));
    document.addEventListener('mousemove',e=>{
      if(this.mouseCaptured&&this.controlling&&!this.inputBlocked())this.applyMouseLook(e.movementX,e.movementY);
    });
    canvas.addEventListener('pointerdown',e=>{
      if(!this.controlling||this.inputBlocked())return;
      if(e.pointerType==='mouse'){
        if(e.button===0&&!this.mouseCaptured)this.capturePointer();
        return;
      }
      if(this.dragPointerId!==null)return;
      this.dragPointerId=e.pointerId;this.dragX=e.clientX;this.dragY=e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('mousedown',e=>{
      if(e.button!==2||!this.controlling||this.inputBlocked())return;
      // Mouse down fires for each button press, including a right press while
      // another button is held. Pointer down does not; never bind both to grab.
      e.preventDefault();this.interact();
    });
    canvas.addEventListener('pointermove',e=>{
      if(!this.controlling||this.inputBlocked()||this.mouseCaptured)return;
      if(e.pointerType==='mouse'){
        if(!this.hoverLook)return;
        if(this.hoverPointer)this.applyMouseLook(e.clientX-this.hoverPointer.x,e.clientY-this.hoverPointer.y);
        this.hoverPointer=new THREE.Vector2(e.clientX,e.clientY);
        return;
      }
      if(this.dragPointerId!==e.pointerId)return;
      this.applyMouseLook(e.clientX-this.dragX,e.clientY-this.dragY);
      this.dragX=e.clientX;this.dragY=e.clientY;
    });
    const stopDragging=(event:PointerEvent)=>{
      if(this.dragPointerId!==event.pointerId)return;
      this.dragPointerId=null;
      if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener('pointerup',stopDragging);
    canvas.addEventListener('pointercancel',stopDragging);
    canvas.addEventListener('pointerleave',()=>{this.hoverPointer=null;});
    canvas.addEventListener('lostpointercapture',()=>{this.dragPointerId=null;});
    canvas.addEventListener('contextmenu',e=>{if(this.controlling)e.preventDefault();});
    canvas.addEventListener('wheel',e=>{
      if(!this.controlling||this.inputBlocked())return;
      e.preventDefault();this.cameraDistance=THREE.MathUtils.clamp(this.cameraDistance+e.deltaY*.008,3.5,17);
    },{passive:false});
    this.renderer.setAnimationLoop(()=>this.frame());
  }
  dragX=0;
  get controlling(){return this.playing||this.exploring;}
  get explorationPosition(){return {x:this.pos.x,z:this.pos.z,yaw:this.yaw};}
  get mouseCaptured(){return document.pointerLockElement===this.renderer.domElement;}
  get mouseLookMode():'captured'|'hover'|'released'{return this.mouseCaptured?'captured':this.hoverLook?'hover':'released';}
  get framesPerSecond(){return this.measuredFps;}
  getSensitivity(){return this.sensitivity;}
  setSensitivity(value:number){
    if(!Number.isFinite(value))return this.sensitivity;
    this.sensitivity=THREE.MathUtils.clamp(value,.25,3);
    try{localStorage.setItem('lootmon-mouse-sensitivity',String(this.sensitivity));}catch{}
    return this.sensitivity;
  }
  get compassHeadingDegrees(){
    this.camera.getWorldDirection(this.headingDirection);
    return THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(Math.atan2(this.headingDirection.x,-this.headingDirection.z)),360);
  }
  get compassHeadingContinuousDegrees(){return this.headingInitialized?this.continuousHeading:this.compassHeadingDegrees;}
  private updateCompassHeading(){
    const heading=this.compassHeadingDegrees;
    if(!this.headingInitialized){this.continuousHeading=heading;this.headingInitialized=true;}
    else this.continuousHeading+=THREE.MathUtils.euclideanModulo(heading-this.lastHeading+180,360)-180;
    this.lastHeading=heading;
  }
  private applyMouseLook(x:number,y:number){
    if(!Number.isFinite(x)||!Number.isFinite(y))return;
    this.angle-=x*.0035*this.sensitivity;
    this.cameraPitch=THREE.MathUtils.clamp(this.cameraPitch+y*.0028*this.sensitivity,.15,1.05);
    if(x||y)this.lookTurnPending=true;
  }
  private updateCameraLook(dt:number){
    if(this.hoverLook&&!this.mouseCaptured&&this.hoverPointer&&!this.inputBlocked()){
      const canvas=this.renderer.domElement,point=this.hoverPointer,rect=canvas.getBoundingClientRect();
      const overCanvas=document.elementFromPoint(point.x,point.y)===canvas;
      if(overCanvas&&rect.width>0&&rect.height>0){
        const edge=(coordinate:number,start:number,size:number)=>{
          const band=Math.min(100,Math.max(40,size*.12));
          const left=coordinate-start,right=start+size-coordinate;
          if(left<0||right<0)return 0;
          if(left<band)return -Math.pow(1-left/band,2);
          if(right<band)return Math.pow(1-right/band,2);
          return 0;
        };
        const x=edge(point.x,rect.left,rect.width),y=edge(point.y,rect.top,rect.height);
        // Embedded browsers may deny pointer lock. Keeping the cursor at an
        // edge continues turning indefinitely, without another drag or prompt.
        this.angle-=x*2.2*this.sensitivity*dt;
        this.cameraPitch=THREE.MathUtils.clamp(this.cameraPitch+y*.85*this.sensitivity*dt,.15,1.05);
        if(x||y)this.lookTurnPending=true;
      }
    }
    const blend=1-Math.exp(-14*dt);
    this.renderedAngle+=(this.angle-this.renderedAngle)*blend;
    this.renderedPitch+=(this.cameraPitch-this.renderedPitch)*blend;
    this.renderedDistance+=(this.cameraDistance-this.renderedDistance)*blend;
  }
  private resetFollowCamera(){
    const x=this.camera.position.x-this.pos.x,z=this.camera.position.z-this.pos.z;
    this.angle=Math.atan2(x,z);this.renderedAngle=this.angle;
    this.renderedPitch=THREE.MathUtils.clamp(Math.atan2(this.camera.position.y-1.45,Math.hypot(x,z)),.15,1.05);
    this.renderedDistance=THREE.MathUtils.clamp(Math.hypot(x,this.camera.position.y-1.45,z),3.5,17);
    this.yaw=this.angle+Math.PI;
  }
  private captureFailed(message:string){
    if(this.mouseCaptured||!this.pointerLockWanted)return;
    this.pointerLockPending=false;this.pointerLockWanted=false;
    if(!this.controlling||this.inputBlocked())return;
    this.hoverLook=true;this.hoverPointer=null;
    this.renderer.domElement.style.cursor='crosshair';
    this.onMouseCaptureChange(false);
    this.onMouseCaptureError(`${message} Move the mouse over the island to look around. Hold it near an edge to keep turning through 360°. Click the island to retry capture; Escape frees the camera.`);
  }
  capturePointer(){
    if(!this.controlling||this.inputBlocked()||this.mouseCaptured||this.pointerLockPending)return;
    this.pointerLockWanted=true;this.pointerLockPending=true;
    this.hoverPointer=null;
    const canvas=this.renderer.domElement;
    if(typeof canvas.requestPointerLock!=='function'){this.captureFailed('Mouse capture is not supported by this browser.');return;}
    try{
      const request=canvas.requestPointerLock();
      // Some browsers implement the older void-returning method; both use the
      // standard change/error events, while Promise rejections are consumed.
      if(request&&typeof request.catch==='function')request.catch(()=>this.captureFailed('Mouse capture needs a click on the island or is blocked by this browser.'));
    }catch{this.captureFailed('Mouse capture is blocked by this browser.');}
  }
  releasePointer(){
    const changed=this.mouseCaptured||this.hoverLook||this.pointerLockPending;
    this.pointerLockWanted=false;this.pointerLockPending=false;this.hoverLook=false;this.hoverPointer=null;this.lookTurnPending=false;
    this.angle=this.renderedAngle;this.cameraPitch=this.renderedPitch;
    this.renderer.domElement.style.cursor='';
    this.clearInput();
    if(this.mouseCaptured)document.exitPointerLock();
    else if(changed)this.onMouseCaptureChange(false);
  }
  private captureDesktopPointer(){if(window.matchMedia('(hover: hover) and (pointer: fine)').matches)this.capturePointer();}
  private inputBlocked(){return document.hidden||!!document.body?.classList.contains('leaderboard-page')||!!document.querySelector('dialog[open]')||!!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');}
  setControl(code:string,pressed:boolean){
    if(!pressed){this.keys.delete(code);return;}
    if(this.controlling&&!this.inputBlocked()&&['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight'].includes(code))this.keys.add(code);
  }
  setMovementInput(strafe:number,forward:number){
    if(!this.controlling||this.inputBlocked()){this.movementInput.set(0,0);return;}
    this.movementInput.set(Number.isFinite(strafe)?THREE.MathUtils.clamp(strafe,-1,1):0,Number.isFinite(forward)?THREE.MathUtils.clamp(forward,-1,1):0);
    if(this.movementInput.length()<.08)this.movementInput.set(0,0);
  }
  clearInput(){
    this.keys.clear();this.movementInput.set(0,0);this.hoverPointer=null;
    if(this.dragPointerId!==null&&this.renderer.domElement.hasPointerCapture(this.dragPointerId))this.renderer.domElement.releasePointerCapture(this.dragPointerId);
    this.dragPointerId=null;
  }
  interact(){
    if(!this.controlling||this.inputBlocked())return;
    if(this.playing&&this.id)this.characters.get(this.id)?.playOnce('Interact');
    else this.lobbyCharacter?.playOnce('Interact');
    if(this.exploring)this.onExploreAction('interact');
    else if(this.playing)this.onInteract();
  }
  private networkNow(){return Date.now()+this.serverClockOffset;}
  private jumpHeight(start:number|undefined,until:number|undefined,now:number){
    if(!start||!until||now<start||now>=until||until<=start)return 0;
    const progress=(now-start)/(until-start);
    return 4*JUMP_PEAK*progress*(1-progress);
  }
  private resetJump(){this.localJumpStartedAt=0;this.localJumpUntil=0;this.localJumpReadyAt=0;this.jumpPending=false;this.visualJumpHeight=0;}
  jump(){
    if(!this.controlling||this.inputBlocked())return false;
    const now=this.networkNow();
    const me=this.state?.players.find(player=>player.id===this.id) as (Player&JumpState)|undefined;
    if(this.playing&&!me)return false;
    if(now<this.localJumpReadyAt||now<(me?.jumpReadyAt??0))return false;
    this.localJumpStartedAt=now;this.localJumpUntil=now+JUMP_DURATION_MS;this.localJumpReadyAt=now+JUMP_DURATION_MS+JUMP_RECOVERY_MS;
    this.jumpPending=this.playing;
    if(this.playing)this.onJump();
    return true;
  }
  activateAbility(ability:'radar'|'dash'){
    if(this.inputBlocked())return;
    if(this.exploring)this.onExploreAction(ability);
    else if(this.playing)this.onAbility(ability);
  }
  async enterExplore(){
    await this.ready;
    if(this.playing)throw new Error('Leave the live expedition before exploring the island.');
    if(this.exploring)return;
    this.leave();
    if(this.blocked(this.pos.x,this.pos.z))this.pos.copy(this.world.spawn);
    this.exploring=true;this.id=null;this.overview=false;this.controls.enabled=false;this.controls.autoRotate=false;
    this.resetFollowCamera();this.lobbyAvatar.rotation.y=this.yaw;this.lobbyAvatar.visible=true;this.lobbyAvatar.position.copy(this.pos);
    this.renderer.domElement.style.touchAction='none';
    if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
    this.clearInput();
    this.captureDesktopPointer();
  }
  leaveExplore(){if(!this.exploring)return;this.leave();this.onExitExplore();}
  setPlaying(id:string){this.clearInput();this.resetJump();this.exploring=false;this.lobbyAvatar.visible=false;this.id=id;this.playing=true;this.overview=false;this.controls.enabled=false;this.controls.autoRotate=false;const me=this.state?.players.find(p=>p.id===id) as (Player&JumpState)|undefined;if(me){this.pos.set(me.x,0,me.z);this.localJumpStartedAt=me.jumpStartedAt??0;this.localJumpUntil=me.jumpUntil??0;this.localJumpReadyAt=me.jumpReadyAt??0;}this.resetFollowCamera();if(document.activeElement instanceof HTMLElement)document.activeElement.blur();this.captureDesktopPointer();}
  leave(){this.releasePointer();this.resetJump();for(const id of [...this.characters.keys()])this.removeAvatar(id);for(const g of [...this.packMeshes.values(),...this.bases.values()])this.removeWorldObject(g);this.packMeshes.clear();this.bases.clear();this.state=null;this.lobbyAvatar.visible=true;this.lobbyAvatar.position.copy(this.pos);this.playing=false;this.exploring=false;this.id=null;this.controls.enabled=true;this.controls.target.set(this.pos.x,1.3,this.pos.z);this.controls.autoRotate=false;this.controls.update();}
  setState(state:GameState){
    this.state=state;
    const serverTime=(state as GameState&{serverTime?:number}).serverTime;
    if(Number.isFinite(serverTime)){
      const offset=serverTime!-Date.now();
      this.serverClockOffset=this.serverClockKnown?this.serverClockOffset*.9+offset*.1:offset;this.serverClockKnown=true;
    }
    const me=state.players.find(p=>p.id===this.id) as (Player&JumpState)|undefined;
    if(!me)return;
    if(Math.hypot(this.pos.x-me.x,this.pos.z-me.z)>3)this.pos.set(me.x,0,me.z);
    const now=this.networkNow();
    if((me.jumpUntil??0)>now&&(me.jumpStartedAt??0)>=this.localJumpStartedAt-150){
      this.localJumpStartedAt=me.jumpStartedAt??0;this.localJumpUntil=me.jumpUntil??0;this.localJumpReadyAt=me.jumpReadyAt??0;this.jumpPending=false;
    }else if(this.jumpPending&&now-this.localJumpStartedAt>350){
      this.localJumpUntil=0;this.jumpPending=false;this.localJumpReadyAt=Math.max(now+JUMP_RECOVERY_MS,me.jumpReadyAt??0);
    }
  }
  selectCharacter(variant:CharacterVariant){this.variant=variant;try{localStorage.setItem('cards-character',variant)}catch{}if(this.lobbyCharacter){this.scene.remove(this.lobbyCharacter.group);this.lobbyCharacter.dispose();}this.lobbyCharacter=createCharacter(variant);this.lobbyAvatar=this.lobbyCharacter.group;this.lobbyAvatar.position.copy(this.pos);this.lobbyAvatar.rotation.y=this.exploring?this.yaw:.45;this.lobbyAvatar.visible=!this.playing;this.scene.add(this.lobbyAvatar);}
  gesture(name:'PickUp'|'Interact'|'Cheer'){if(this.id)this.characters.get(this.id)?.playOnce(name);else this.lobbyCharacter?.playOnce(name);}
  private removeWorldObject(group:THREE.Group){
    this.scene.remove(group);
    group.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose();}});
    group.clear();
  }
  private removeAvatar(id:string){
    const actor=this.characters.get(id),ring=actor?.group.getObjectByName('PlayerMarker');
    // This marker is owned by Game, outside CharacterInstance's shared rig.
    if(ring instanceof THREE.Mesh){ring.geometry.dispose();for(const material of Array.isArray(ring.material)?ring.material:[ring.material])material.dispose();}
    if(actor){this.scene.remove(actor.group);actor.dispose();}
    this.characters.delete(id);this.avatarMeshes.delete(id);
  }
  makeAvatar(id:string,variant:CharacterVariant,color:number){const actor=createCharacter(variant,color);this.characters.set(id,actor);const ring=new THREE.Mesh(new THREE.RingGeometry(.62,.69,32),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.65,side:THREE.DoubleSide}));ring.name='PlayerMarker';ring.rotation.x=-Math.PI/2;ring.position.y=.035;actor.group.add(ring);return actor.group;}
  makePack(value:number){const g=new THREE.Group();const color=COLORS[value]??COLORS[25];const m=new THREE.Mesh(new THREE.BoxGeometry(.82,1.14,.18),new THREE.MeshStandardMaterial({color,metalness:.65,roughness:.3}));m.castShadow=true;g.add(m);const inner=new THREE.Mesh(new THREE.BoxGeometry(.65,.85,.19),new THREE.MeshStandardMaterial({color:0x273d36,roughness:.35,metalness:.3}));g.add(inner);const gem=new THREE.Mesh(new THREE.OctahedronGeometry(.26),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.4,metalness:.6,roughness:.3}));gem.position.z=.2;g.add(gem);for(const y of [-.51,.51]){const seam=new THREE.Mesh(new THREE.BoxGeometry(.84,.09,.21),new THREE.MeshStandardMaterial({color,metalness:.8,roughness:.4}));seam.position.y=y;g.add(seam);}
    const halo=new THREE.Mesh(new THREE.RingGeometry(.8,1.05,32),new THREE.MeshBasicMaterial({color:0xffdf67,transparent:true,opacity:.8,side:THREE.DoubleSide,depthWrite:false}));halo.rotation.x=-Math.PI/2;halo.position.y=-.85;g.add(halo);
    const pointer=new THREE.Mesh(new THREE.ConeGeometry(.3,.65,4),new THREE.MeshBasicMaterial({color:0xffdf67,depthTest:false,depthWrite:false}));pointer.rotation.z=Math.PI;pointer.position.y=1.4;pointer.renderOrder=8;pointer.name='DiscoveryPointer';g.add(pointer);
    return g;}
  makeBase(color:number){const g=new THREE.Group();const ring=new THREE.Mesh(new THREE.RingGeometry(3.3,3.65,64),new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:.65}));ring.rotation.x=-Math.PI/2;ring.position.y=.06;g.add(ring);const box=new THREE.Mesh(new THREE.BoxGeometry(1.2,.7,.8),new THREE.MeshStandardMaterial({color:0x374b40,metalness:.25,roughness:.6}));box.position.set(0,.35,0);box.castShadow=true;g.add(box);const strip=new THREE.Mesh(new THREE.BoxGeometry(1.23,.1,.83),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.4}));strip.position.y=.58;g.add(strip);return g;}
  blocked(x:number,z:number){return Math.abs(x)>124||Math.abs(z)>124||collidesWithWorld(this.world.colliders,x,z,.6)}
  private moveBy(x:number,z:number){
    const startX=this.pos.x,startZ=this.pos.z;
    const steps=Math.max(1,Math.ceil(Math.hypot(x,z)/.24));
    for(let index=0;index<steps;index++){
      if(!this.blocked(this.pos.x+x/steps,this.pos.z))this.pos.x+=x/steps;
      if(!this.blocked(this.pos.x,this.pos.z+z/steps))this.pos.z+=z/steps;
    }
    return Math.hypot(this.pos.x-startX,this.pos.z-startZ)>.0001;
  }
  private followCamera(){
    this.aim.set(this.pos.x,1.45+this.visualJumpHeight*.6,this.pos.z);
    const horizontal=Math.cos(this.renderedPitch)*this.renderedDistance;
    const desired=this.cameraDesired.set(this.pos.x+Math.sin(this.renderedAngle)*horizontal,this.aim.y+Math.sin(this.renderedPitch)*this.renderedDistance,this.pos.z+Math.cos(this.renderedAngle)*horizontal);
    const ray=this.cameraDirection.copy(desired).sub(this.aim);const distance=ray.length();
    this.cameraRay.set(this.aim,ray.normalize());this.cameraRay.near=.35;this.cameraRay.far=distance;
    this.cameraHits.length=0;const wall=this.cameraRay.intersectObjects(this.cameraObstacles,true,this.cameraHits)[0];
    if(wall)desired.copy(this.aim).addScaledVector(ray,Math.max(.8,wall.distance-.35));
    // Smooth orbit angles, not a chord through the character during a turn.
    this.camera.position.copy(desired);this.camera.lookAt(this.aim);
  }
  frame(){const elapsed=this.clock.getDelta();if(document.hidden){this.fpsSampleStartedAt=0;return;}const dt=Math.min(elapsed,.05);this.elapsed+=dt;const t=this.elapsed;this.world.update(t);if(!this.controlling)this.lobbyCharacter?.update(dt,{moving:false,sprinting:false,carrying:false});
    const me=this.state?.players.find(p=>p.id===this.id);let moving=false;
    const jumpNow=this.networkNow();
    this.visualJumpHeight=this.controlling?this.jumpHeight(this.localJumpStartedAt,this.localJumpUntil,jumpNow):0;
    if(this.exploring||(this.playing&&me)){
      const blockedInput=this.inputBlocked();
      if(blockedInput)this.releasePointer();
      else this.updateCameraLook(dt);
      const f=(this.keys.has('KeyW')||this.keys.has('ArrowUp')?1:0)-(this.keys.has('KeyS')||this.keys.has('ArrowDown')?1:0)+this.movementInput.y;
      const r=(this.keys.has('KeyD')||this.keys.has('ArrowRight')?1:0)-(this.keys.has('KeyA')||this.keys.has('ArrowLeft')?1:0)+this.movementInput.x;
      const sprint=(this.keys.has('ShiftLeft')||this.keys.has('ShiftRight'))&&(this.exploring||(me?.stamina??100)>3);
      const speed=this.exploring?(sprint?12:7):((me?.ability==='dash'&&jumpNow<(me.abilityUntil??0)?20:sprint?15:10)*(me?.carrying?.8:1));
      if(f||r){
        let x=-Math.sin(this.renderedAngle)*f+Math.cos(this.renderedAngle)*r;let z=-Math.cos(this.renderedAngle)*f-Math.sin(this.renderedAngle)*r;
        const length=Math.hypot(x,z),strength=Math.min(1,Math.hypot(f,r));x=x/length*speed*dt*strength;z=z/length*speed*dt*strength;
        moving=this.moveBy(x,z);this.yaw=Math.atan2(x,z);if(moving&&this.visualJumpHeight<.06)this.onStep(sprint);
      }else if(!blockedInput&&(this.mouseCaptured||this.hoverLook||this.dragPointerId!==null||this.lookTurnPending))this.yaw=this.renderedAngle+Math.PI;
      this.lookTurnPending=false;
      if(this.playing&&t-this.lastSend>.05){this.lastSend=t;this.onMove(this.pos.x,this.pos.z,this.yaw,sprint)}
      if(this.exploring){
        this.lobbyAvatar.position.copy(this.pos);
        this.lobbyAvatar.position.y+=this.visualJumpHeight;
        this.lobbyAvatar.rotation.y+=Math.atan2(Math.sin(this.yaw-this.lobbyAvatar.rotation.y),Math.cos(this.yaw-this.lobbyAvatar.rotation.y))*Math.min(1,dt*15);
        this.lobbyCharacter?.update(dt,{moving,sprinting:sprint,carrying:false});
      }
      if(!blockedInput)this.followCamera();
    }else this.controls.update();
    if(this.state&&!this.exploring){const ids=new Set(this.state.players.map(p=>p.id));for(const id of this.avatarMeshes.keys())if(!ids.has(id)){this.removeAvatar(id);const b=this.bases.get(id);if(b)this.removeWorldObject(b);this.bases.delete(id);}
      for(const p of this.state.players){let g=this.avatarMeshes.get(p.id);if(g&&g.userData.characterVariant!==(p.character??'scout')){this.removeAvatar(p.id);g=undefined;}if(!g){g=this.makeAvatar(p.id,p.character??'scout',p.id===this.id?0xd7f887:0xe39a77);g.position.set(p.x,0,p.z);g.rotation.y=p.yaw;this.scene.add(g);this.avatarMeshes.set(p.id,g);if(!this.bases.has(p.id)){const b=this.makeBase(p.id===this.id?0xd7f887:0xe39a77);this.scene.add(b);this.bases.set(p.id,b);}}
        this.bases.get(p.id)?.position.set(p.base.x,0,p.base.z);
        const local=p.id===this.id;const jump=p as Player&JumpState;const height=local?this.visualJumpHeight:this.jumpHeight(jump.jumpStartedAt,jump.jumpUntil,jumpNow);const target=local?this.avatarTarget.set(this.pos.x,this.pos.y+height,this.pos.z):this.avatarTarget.set(p.x,height,p.z);const dist=Math.hypot(g.position.x-target.x,g.position.z-target.z);g.position.lerp(target,local?1:Math.min(1,dt*13));const desiredYaw=local?this.yaw:p.yaw;g.rotation.y+=Math.atan2(Math.sin(desiredYaw-g.rotation.y),Math.cos(desiredYaw-g.rotation.y))*Math.min(1,dt*15);const walk=local?moving:dist>.08;this.characters.get(p.id)?.update(dt,{moving:walk,sprinting:local?(this.keys.has('ShiftLeft')||this.keys.has('ShiftRight')):dist>1,carrying:!!p.carrying});
      }
      const packIds=new Set(this.state.packs.filter(p=>p.status!=='secured').map(p=>p.id));for(const [id,g]of this.packMeshes)if(!packIds.has(id)){this.removeWorldObject(g);this.packMeshes.delete(id);}
      // The authority already filters hidden packs by radius and sight lines.
      // Re-filtering with the client's clock can hide valid radar discoveries.
      for(const p of this.state.packs){if(p.status==='secured')continue;let g=this.packMeshes.get(p.id);if(!g){g=this.makePack(p.tier);this.packMeshes.set(p.id,g);this.scene.add(g);}const carrier=this.state.players.find(pl=>pl.id===p.carrierId||pl.carrying===p.id);const pointer=g.getObjectByName('DiscoveryPointer');if(pointer)pointer.visible=!carrier;if(carrier){const c=carrier.id===this.id?this.pos:carrier;const jump=carrier as Player&JumpState;const height=carrier.id===this.id?this.visualJumpHeight:this.jumpHeight(jump.jumpStartedAt,jump.jumpUntil,jumpNow);g.position.set(c.x,2.8+height+Math.sin(t*3)*.06,c.z);g.visible=true;}else{g.position.set(p.x,1.15+Math.sin(t*2)*.13,p.z);g.visible=!!me;}g.rotation.y=t*.55;}
    }
    this.updateCompassHeading();
    this.renderer.render(this.scene,this.camera);
    const renderedAt=performance.now();
    if(!this.fpsSampleStartedAt){this.fpsSampleStartedAt=renderedAt;this.fpsSampleFrames=0;}
    else{
      this.fpsSampleFrames++;
      const span=renderedAt-this.fpsSampleStartedAt;
      if(span>=1000){const measured=this.fpsSampleFrames*1000/span;this.measuredFps=this.measuredFps?this.measuredFps*.35+measured*.65:measured;this.fpsSampleStartedAt=renderedAt;this.fpsSampleFrames=0;}
    }
  }
  focus(x:number,z:number){if(this.controlling)return;this.controls.target.set(x,0,z);this.camera.position.set(x+28,32,z+34);this.controls.autoRotate=false;}
  toggleOverview(){if(this.controlling)return;this.overview=!this.overview;if(this.overview){this.controls.target.set(0,0,-12);this.camera.position.set(83,76,102);this.controls.autoRotate=true;}else{this.controls.target.set(this.pos.x,1.25,this.pos.z);this.camera.position.set(this.pos.x+7,6.3,this.pos.z+11);this.controls.autoRotate=false;}}
  mapSnapshot(){if(this.mapImage)return this.mapImage;const n=1024;const target=new THREE.WebGLRenderTarget(n,n);target.texture.colorSpace=THREE.SRGBColorSpace;const camera=new THREE.OrthographicCamera(-140,140,140,-140,1,500);camera.position.set(0,300,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);const fog=this.scene.fog;const bg=this.scene.background;const prior=this.renderer.getRenderTarget();const hidden=[this.lobbyAvatar,...this.avatarMeshes.values(),...this.packMeshes.values(),...this.bases.values()];const visibility=hidden.map(g=>g.visible);hidden.forEach(g=>g.visible=false);this.scene.fog=null;this.scene.background=new THREE.Color('#80af8a');this.renderer.setRenderTarget(target);this.renderer.render(this.scene,camera);const bytes=new Uint8Array(n*n*4);this.renderer.readRenderTargetPixels(target,0,0,n,n,bytes);this.renderer.setRenderTarget(prior);this.scene.fog=fog;this.scene.background=bg;hidden.forEach((g,i)=>g.visible=visibility[i]);target.dispose();const canvas=document.createElement('canvas');canvas.width=n;canvas.height=n;const ctx=canvas.getContext('2d')!;const data=ctx.createImageData(n,n);for(let y=0;y<n;y++)data.data.set(bytes.subarray((n-1-y)*n*4,(n-y)*n*4),y*n*4);ctx.putImageData(data,0,0);this.mapImage=canvas;return canvas;}
  setQuality(high:boolean){this.quality=high;this.renderer.setPixelRatio(Math.min(devicePixelRatio,high?1.6:1));this.renderer.shadowMap.enabled=high;}
}
