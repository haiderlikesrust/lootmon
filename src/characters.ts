import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type CharacterVariant = 'scout' | 'ranger' | 'sage';
export const CHARACTER_OPTIONS: ReadonlyArray<{ id: CharacterVariant; name: string; description: string }> = [
  { id: 'scout', name: 'Trail Scout', description: 'An agile explorer with a trusty expedition pack.' },
  { id: 'ranger', name: 'Forest Ranger', description: 'A hooded wanderer made for the hidden paths.' },
  { id: 'sage', name: 'Arcane Sage', description: 'A curious collector with a little woodland magic.' },
];

type CharacterMotion = { moving: boolean; sprinting: boolean; carrying: boolean };
type Gesture = 'PickUp' | 'Interact' | 'Cheer';
type AnimationLayer = 'upper' | 'lower';
export type CharacterInstance = {
  group: THREE.Group;
  update(dt: number, motion: CharacterMotion): void;
  playOnce(name: Gesture): void;
  dispose(): void;
};
type Template = { scene: THREE.Group; clips: THREE.AnimationClip[] };
const templates = new Map<CharacterVariant, Template>();
const ASSETS: Record<CharacterVariant, string> = {
  scout: '/models/kaykit-adventurers/Rogue.glb',
  ranger: '/models/kaykit-adventurers/Rogue_Hooded.glb',
  sage: '/models/kaykit-adventurers/Mage.glb',
};
const REQUIRED_CLIPS = ['Idle', 'Walking_A', 'Running_A', 'Running_B', 'PickUp', 'Interact', 'Cheer'];
let loading: Promise<void> | null = null;

function prepareTemplate(gltf: GLTF, variant: CharacterVariant): Template {
  const removed: THREE.Object3D[] = [];
  gltf.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    // Equipment bones stay intact for animation bindings. The asset's cape is
    // replaced with expedition equipment; no weapons accompany these hunters.
    if (/cape|sword|knife|crossbow|bow_|staff|weapon|shield|throwable/i.test(object.name)) removed.push(object);
    else {
      object.castShadow = true;
      object.receiveShadow = true;
      if (object instanceof THREE.SkinnedMesh) object.frustumCulled = false;
    }
  });
  removed.forEach(object => object.removeFromParent());
  const clips = gltf.animations.map(original => {
    const clip = original.clone();
    for (const track of clip.tracks) {
      if (!/(?:^|[/.])(?:root|Rig|Armature)\.position$/i.test(track.name) || track.getValueSize() !== 3) continue;
      // Keep vertical weight shifts, but never let authored root movement move
      // a hunter away from their authoritative game coordinates.
      const x = track.values[0];
      const z = track.values[2];
      for (let index = 0; index < track.values.length; index += 3) {
        track.values[index] = x;
        track.values[index + 2] = z;
      }
    }
    return clip;
  });
  for (const name of REQUIRED_CLIPS) {
    if (!clips.some(clip => clip.name === name)) throw new Error(`The ${variant} character is missing its ${name} animation.`);
  }
  const spine = gltf.scene.getObjectByName('spine');
  if (!spine) throw new Error(`The ${variant} character has no spine animation hierarchy.`);
  const upperBones = new Set<string>();
  spine.traverse(object => upperBones.add(object.name));
  // These baked arm controls are siblings of the hips in the KayKit rig. All
  // root, pelvis, leg, foot and foot-control tracks belong to the lower layer.
  gltf.scene.traverse(object => {
    if (/^(?:elbow|hand)ik[lr]$/i.test(object.name.replace(/[^a-z0-9]/gi, ''))) upperBones.add(object.name);
  });
  const isUpperTrack = (track: THREE.KeyframeTrack) => upperBones.has(THREE.PropertyBinding.parseTrackName(track.name).nodeName);
  const layeredClips = clips.flatMap(clip => (['lower', 'upper'] as const).map(layer => {
    const tracks = clip.tracks.filter(track => isUpperTrack(track) === (layer === 'upper'));
    if (!tracks.length) throw new Error(`The ${variant} ${clip.name} animation has no ${layer}-body tracks.`);
    return new THREE.AnimationClip(`${clip.name}:${layer}`, clip.duration, tracks);
  }));
  return { scene: gltf.scene, clips: layeredClips };
}

/** Load every selectable model before creating the world. A failed model load
 * rejects explicitly so the interface can offer retry instead of a substitute. */
export async function loadCharacters(): Promise<void> {
  if (templates.size === CHARACTER_OPTIONS.length) return;
  if (!loading) {
    const loader = new GLTFLoader();
    loading = Promise.all(CHARACTER_OPTIONS.map(async option => {
      try {
        return [option.id, prepareTemplate(await loader.loadAsync(ASSETS[option.id]), option.id)] as const;
      } catch (error) {
        throw new Error(`Could not load ${option.name}. Check the character assets and try again.`, { cause: error });
      }
    })).then(loaded => {
      for (const [variant, template] of loaded) templates.set(variant, template);
    }).catch(error => {
      loading = null;
      throw error;
    });
  }
  await loading;
}

/** Skeletons, animation mixers, material instances, and accessories are private
 * to each hunter. Large source geometries and atlas textures remain shared. */
export function createCharacter(variant: CharacterVariant, accentColor = 0xd7f887): CharacterInstance {
  const template = templates.get(variant);
  if (!template) throw new Error(`Character ${variant} is not loaded. Await loadCharacters() before creating hunters.`);
  const group = new THREE.Group();
  group.name = `Hunter_${variant}`;
  group.userData.characterVariant = variant;
  const model = cloneSkeleton(template.scene) as THREE.Group;
  model.name = `Model_${variant}`;
  const normalization = new THREE.Group();
  normalization.name = 'CharacterBody';
  normalization.add(model);
  group.add(normalization);

  const materials = new Set<THREE.Material>();
  const geometry = new Set<THREE.BufferGeometry>();
  const skeletons = new Set<THREE.Skeleton>();
  const materialCopies = new Map<THREE.Material, THREE.Material>();
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const copy = (material: THREE.Material) => {
      let instance = materialCopies.get(material);
      if (!instance) {
        instance = material.clone();
        materialCopies.set(material, instance);
        materials.add(instance);
      }
      return instance;
    };
    object.material = Array.isArray(object.material) ? object.material.map(copy) : copy(object.material);
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    object.castShadow = true;
    object.receiveShadow = true;
  });

  const mixer = new THREE.AnimationMixer(model);
  const actions = new Map(template.clips.map(clip => [clip.name, mixer.clipAction(clip)]));
  const idleLower = actions.get('Idle:lower')!;
  const idleUpper = actions.get('Idle:upper')!;
  idleLower.play();
  idleUpper.play();
  mixer.update(0);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  const size = bounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.y) || size.y < 0.05) throw new Error(`The ${variant} character has invalid geometry.`);
  const bodyScale = 2.1 / size.y;
  normalization.scale.setScalar(bodyScale);
  normalization.position.set(-(bounds.min.x + bounds.max.x) * 0.5 * bodyScale, -bounds.min.y * bodyScale, -(bounds.min.z + bounds.max.z) * 0.5 * bodyScale);

  const material = (color: number, roughness = 0.9, metalness = 0) => {
    const result = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    materials.add(result);
    return result;
  };
  const leather = material(variant === 'sage' ? 0x6b5550 : 0x78533b);
  const warmLeather = material(0xa87c50);
  const darkLeather = material(0x3d352d);
  const brass = material(0xccaa67, 0.42, 0.64);
  const canvas = material(variant === 'sage' ? 0x84957e : 0x71816b);
  const lining = material(0xc8b695);
  const accent = material(accentColor, 0.68);
  accent.emissive.setHex(accentColor);
  accent.emissiveIntensity = 0.025;
  const attach = (parent: THREE.Object3D, shape: THREE.BufferGeometry, finish: THREE.Material, position: [number, number, number], rotation?: [number, number, number]) => {
    geometry.add(shape);
    const mesh = new THREE.Mesh(shape, finish);
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const rounded = (width: number, height: number, depth: number, radius = 0.035) => new RoundedBoxGeometry(width, height, depth, 2, radius);
  const chest = model.getObjectByName('chest') ?? model.getObjectByName('spine');
  if (!chest) throw new Error(`The ${variant} character has no spine attachment bone.`);
  const pack = new THREE.Group();
  pack.name = 'ExpeditionBackpack';
  chest.add(pack);
  attach(pack, rounded(0.38, 0.43, 0.23), leather, [0, -0.115, -0.285]);
  attach(pack, rounded(0.4, 0.145, 0.25, 0.025), warmLeather, [0, 0.09, -0.293]);
  attach(pack, rounded(0.24, 0.18, 0.055, 0.018), warmLeather, [0, -0.19, -0.415]);
  attach(pack, rounded(0.22, 0.025, 0.066, 0.01), darkLeather, [0, -0.105, -0.42]);
  for (const x of [-0.13, 0.13]) {
    attach(pack, rounded(0.038, 0.37, 0.028, 0.008), darkLeather, [x, -0.065, -0.42]);
    attach(pack, new THREE.BoxGeometry(0.058, 0.065, 0.018), brass, [x, -0.035, -0.439]);
    attach(pack, new THREE.BoxGeometry(0.027, 0.036, 0.02), leather, [x, -0.035, -0.451]);
    const strap = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, -0.3, 0.13), new THREE.Vector3(x, 0.03, 0.18),
      new THREE.Vector3(x, 0.16, -0.02), new THREE.Vector3(x, 0.08, -0.26),
    ]);
    attach(pack, new THREE.TubeGeometry(strap, 12, 0.024, 5, false), darkLeather, [0, 0, 0]);
    attach(pack, new THREE.BoxGeometry(0.038, 0.055, 0.014), brass, [x, -0.12, 0.156]);
  }
  // Rolled bedroll with visible end rings and two tied leather straps.
  attach(pack, new THREE.CylinderGeometry(0.077, 0.077, 0.46, 12), canvas, [0, 0.205, -0.29], [0, 0, Math.PI / 2]);
  for (const x of [-0.234, 0.234]) {
    attach(pack, new THREE.TorusGeometry(0.054, 0.009, 5, 14), lining, [x, 0.205, -0.29], [0, Math.PI / 2, 0]);
    attach(pack, new THREE.TorusGeometry(0.027, 0.007, 5, 12), lining, [x, 0.205, -0.29], [0, Math.PI / 2, 0]);
  }
  for (const x of [-0.145, 0.145]) attach(pack, new THREE.TorusGeometry(0.078, 0.013, 5, 12), darkLeather, [x, 0.205, -0.29], [0, Math.PI / 2, 0]);
  attach(pack, rounded(0.1, 0.2, 0.12, 0.022), canvas, [-0.232, -0.145, -0.28]);
  attach(pack, new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), lining, [0.228, -0.065, -0.285], [0, 0, -0.13]);
  attach(pack, new THREE.TorusGeometry(0.037, 0.008, 4, 8), darkLeather, [0.225, -0.11, -0.285], [Math.PI / 2, 0, 0]);
  const badge = attach(chest, new THREE.CylinderGeometry(0.046, 0.046, 0.018, 6), brass, [-0.072, -0.045, 0.203], [Math.PI / 2, 0, 0]);
  attach(badge, new THREE.CylinderGeometry(0.03, 0.03, 0.021, 4), accent, [0, 0, 0]);
  const pennantShape = new THREE.Shape();
  pennantShape.moveTo(-0.018, 0.03); pennantShape.lineTo(0.038, 0.014); pennantShape.lineTo(0.025, -0.1); pennantShape.lineTo(-0.035, -0.074); pennantShape.closePath();
  const pennant = attach(chest, new THREE.ShapeGeometry(pennantShape), accent, [-0.12, -0.078, 0.206]);
  pennant.rotation.z = -0.18;
  const ownership = new THREE.MeshBasicMaterial({ color: accentColor, transparent: true, opacity: 0.52, side: THREE.DoubleSide, depthWrite: false });
  materials.add(ownership);
  attach(group, new THREE.RingGeometry(0.42, 0.455, 40), ownership, [0, 0.024, 0], [-Math.PI / 2, 0, 0]).castShadow = false;

  const current: Record<AnimationLayer, THREE.AnimationAction> = { lower: idleLower, upper: idleUpper };
  let gesture: { action: THREE.AnimationAction; fullLower: boolean } | null = null;
  let motion: CharacterMotion = { moving: false, sprinting: false, carrying: false };
  let disposed = false;
  const lowerLocomotion = () => !motion.moving ? 'Idle' : motion.sprinting ? 'Running_A' : 'Walking_A';
  const upperLocomotion = () => !motion.moving ? 'Idle' : motion.carrying ? 'Running_B' : lowerLocomotion();
  const gaitSpeed = () => !motion.moving ? 1 : (motion.sprinting ? 1.25 : 1.35) * (motion.carrying ? 0.8 : 1);
  function transition(layer: AnimationLayer, name: string, once = false) {
    const next = actions.get(`${name}:${layer}`)!;
    if (!once && current[layer] === next) return next;
    const previous = current[layer];
    const previousDuration = previous.getClip().duration;
    const nextDuration = next.getClip().duration;
    const phase = previousDuration > 0 ? (previous.time % previousDuration) / previousDuration : 0;
    const resumedTime = next.time;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
    // Walk/run changes preserve cycle phase. Reach gestures never restart the
    // lower action of a moving character, including when carrying changes.
    if (!once) next.time = previous.loop === THREE.LoopRepeat ? phase * nextDuration : resumedTime % nextDuration;
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.enabled = true;
    next.fadeIn(0.18).play();
    if (previous !== next) previous.fadeOut(0.18);
    current[layer] = next;
    return next;
  }
  function updateLocomotion() {
    // A standing full-body pickup yields its legs as soon as movement begins;
    // stopping/restarting during that gesture never reclaims the leg layer.
    if (gesture?.fullLower && motion.moving) gesture.fullLower = false;
    if (!gesture?.fullLower) {
      transition('lower', lowerLocomotion());
      current.lower.setEffectiveTimeScale(gaitSpeed());
    }
    if (!gesture) {
      transition('upper', upperLocomotion());
      const lowerDuration = current.lower.getClip().duration;
      const upperDuration = current.upper.getClip().duration;
      current.upper.time = current.lower.time / lowerDuration * upperDuration;
      current.upper.setEffectiveTimeScale(gaitSpeed() * upperDuration / lowerDuration);
    }
  }
  const onFinished = (event: { action: THREE.AnimationAction }) => {
    if (event.action !== gesture?.action) return;
    gesture = null;
    updateLocomotion();
  };
  mixer.addEventListener('finished', onFinished);

  return {
    group,
    update(dt, nextMotion) {
      if (disposed || !Number.isFinite(dt)) return;
      motion = nextMotion;
      updateLocomotion();
      accent.emissiveIntensity = motion.carrying ? 0.18 : 0.025;
      mixer.update(THREE.MathUtils.clamp(dt, 0, 0.1));
    },
    playOnce(name) {
      if (disposed) return;
      const fullLower = !motion.moving;
      const action = transition('upper', name, true);
      if (fullLower) transition('lower', name, true);
      gesture = { action, fullLower };
      updateLocomotion();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mixer.removeEventListener('finished', onFinished);
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      skeletons.forEach(skeleton => skeleton.dispose());
      geometry.forEach(shape => shape.dispose());
      materials.forEach(finish => finish.dispose());
      group.removeFromParent();
      group.clear();
    },
  };
}
