import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

/** Index the fixed island geometry once. Characters keep their ordinary raycast. */
export function accelerateCameraGeometry(objects: THREE.Object3D[]) {
  for (const root of objects) root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || object instanceof THREE.SkinnedMesh) return;
    const geometry = object.geometry;
    if ((geometry.index?.count ?? geometry.attributes.position?.count ?? 0) < 300) return;
    geometry.boundsTree ??= new MeshBVH(geometry);
    object.raycast = acceleratedRaycast;
  });
}
