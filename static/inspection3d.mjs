import * as THREE from "/vendor/three.module.js";

const view = document.querySelector("#inspection-car-view");
const scene = new THREE.Scene();
scene.background = new THREE.Color("#f2f6f9");
scene.fog = new THREE.Fog("#f2f6f9", 9, 18);
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.setAttribute("aria-label", "指またはマウスで回転できる3D車両モデル");
view.prepend(renderer.domElement);

scene.add(new THREE.HemisphereLight("#ffffff", "#73879a", 2.1));
const keyLight = new THREE.DirectionalLight("#ffffff", 3.2);
keyLight.position.set(-4, 7, 5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(512, 512);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight("#c8e4ff", 1.25);
fillLight.position.set(4, 3, -5);
scene.add(fillLight);

const car = new THREE.Group();
scene.add(car);
const paint = new THREE.MeshPhysicalMaterial({
  color: "#d8e3e9",
  metalness: 0.22,
  roughness: 0.3,
  clearcoat: 0.9,
  clearcoatRoughness: 0.2,
});
const glass = new THREE.MeshPhysicalMaterial({
  color: "#183348",
  metalness: 0.22,
  roughness: 0.16,
  transmission: 0.08,
  clearcoat: 1,
});
const trim = new THREE.MeshStandardMaterial({ color: "#263746", metalness: 0.24, roughness: 0.42 });
const chrome = new THREE.MeshStandardMaterial({ color: "#c7d3dc", metalness: 0.82, roughness: 0.23 });

function extrudedPanel(points, depth, material, z) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: 0.045,
    bevelThickness: 0.045,
    curveSegments: 4,
  });
  geometry.translate(0, 0, z);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  car.add(mesh);
  return mesh;
}

const bodyProfile = [
  [-2.22, 0.42], [-2.06, 0.72], [-1.5, 0.83], [-1.13, 1.02],
  [-0.82, 1.57], [-0.44, 1.76], [0.58, 1.74], [1.08, 1.45],
  [1.52, 0.91], [2.02, 0.78], [2.2, 0.56], [2.13, 0.32],
  [-2.08, 0.32],
];
extrudedPanel(bodyProfile, 1.46, paint, -0.73);
extrudedPanel([
  [-1.05, 1.07], [-0.76, 1.55], [-0.4, 1.72], [0.54, 1.7],
  [0.95, 1.43], [0.7, 1.08],
], 1.15, paint, -0.575);
for (const side of [-1, 1]) {
  const z = side * 0.73;
  extrudedPanel([[-0.94, 1.15], [-0.67, 1.52], [-0.37, 1.63], [-0.3, 1.15]], 0.018, glass, z);
  extrudedPanel([[-0.21, 1.15], [-0.2, 1.63], [0.5, 1.61], [0.84, 1.34], [0.7, 1.15]], 0.018, glass, z);
  const beltline = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.035, 0.025), chrome);
  beltline.position.set(-0.03, 1.04, side * 0.748);
  car.add(beltline);
  for (const x of [-1.35, 1.28]) {
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.25, 32), trim);
    tire.rotation.x = Math.PI / 2;
    tire.position.set(x, 0.43, side * 0.75);
    tire.castShadow = true;
    tire.receiveShadow = true;
    car.add(tire);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.27, 24), chrome);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(x, 0.43, side * 0.75);
    car.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.28, 16), trim);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(x, 0.43, side * 0.75);
    car.add(hub);
  }
}
for (const x of [-2.02, 2.04]) {
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.14, 1.34), trim);
  bumper.position.set(x, 0.45, 0);
  car.add(bumper);
}
for (const side of [-1, 1]) {
  const light = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.13, 0.035),
    new THREE.MeshStandardMaterial({ color: "#fff0bd", emissive: "#8b6931", emissiveIntensity: 0.4 }),
  );
  light.position.set(-2.18, 0.66, side * 0.48);
  car.add(light);
}

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: "#edf2f6", roughness: 0.92 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.03;
floor.receiveShadow = true;
scene.add(floor);

let theta = 0.82;
let phi = 1.18;
const radius = 7.7;
let pointer = null;
let diagramState = { marks: [], damageTypes: [], selectedTypeId: null };
let damageGroups = [];
let renderScheduled = false;
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const surfaceMeshes = [];
car.traverse((object) => {
  if (object.isMesh) surfaceMeshes.push(object);
});

function placeCamera() {
  camera.position.set(
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta),
  );
  camera.lookAt(0, 0.86, 0);
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderer.render(scene, camera);
  });
}

function coordinatesAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return { rect, hits: [] };
  }
  pointerNdc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, camera);
  return { rect, hits: raycaster.intersectObjects([...damageGroups, ...surfaceMeshes], true) };
}

function worldPosition(mark) {
  if ([mark.world_x, mark.world_y, mark.world_z].every(Number.isFinite)) {
    return new THREE.Vector3(mark.world_x, mark.world_y, mark.world_z);
  }
  return new THREE.Vector3((mark.x - 0.5) * 3.7, 0.92 + (0.5 - mark.y) * 0.8, 0.76);
}

function renderDamageMarks() {
  for (const group of damageGroups) {
    car.remove(group);
    group.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
  }
  damageGroups = [];
  const markerMaterial = new THREE.MeshStandardMaterial({
    color: "#ff1525",
    emissive: "#b9000b",
    emissiveIntensity: 1.8,
    roughness: 0.28,
    metalness: 0,
    depthWrite: false,
  });
  const types = new Map(diagramState.damageTypes.map((type) => [type.id, type]));
  for (const mark of diagramState.marks) {
    const type = types.get(mark.damage_type_id);
    if (!type) continue;
    const group = new THREE.Group();
    group.position.copy(worldPosition(mark));
    const normal = new THREE.Vector3(mark.world_nx ?? 0, mark.world_ny ?? 0, mark.world_nz ?? 1);
    if (normal.lengthSq() < 0.01) normal.set(0, 0, 1);
    normal.normalize();
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    const isScratch = type.built_in_key === "scratch" || type.name.includes("傷");
    let geometry;
    if (isScratch) {
      const points = [];
      for (let index = 0; index <= 24; index += 1) {
        const progress = index / 24;
        points.push(new THREE.Vector3(
          (progress - 0.5) * 0.42,
          Math.sin(progress * Math.PI * 6) * 0.045,
          0,
        ));
      }
      geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points),
        48,
        0.022,
        8,
        false,
      );
    } else {
      geometry = new THREE.TorusGeometry(0.115, 0.026, 10, 40);
    }
    const marker = new THREE.Mesh(geometry, markerMaterial);
    marker.userData.markId = mark.id;
    marker.renderOrder = 10;
    group.add(marker);
    car.add(group);
    damageGroups.push(group);
  }
  scheduleRender();
}

function addMark(typeId, hit) {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
  const surfaceNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
  const point = hit.point.clone().addScaledVector(surfaceNormal, 0.035);
  const mark = {
    id: crypto.randomUUID(),
    damage_type_id: typeId,
    x: THREE.MathUtils.clamp((hit.point.x + 2.3) / 4.6, 0, 1),
    y: THREE.MathUtils.clamp(1 - hit.point.y / 1.9, 0, 1),
    world_x: point.x,
    world_y: point.y,
    world_z: point.z,
    world_nx: surfaceNormal.x,
    world_ny: surfaceNormal.y,
    world_nz: surfaceNormal.z,
  };
  view.dispatchEvent(new CustomEvent("inspection:mark", { detail: mark }));
}

function placeAt(typeId, clientX, clientY) {
  const { hits } = coordinatesAt(clientX, clientY);
  const surfaceHit = hits.find((hit) => surfaceMeshes.includes(hit.object));
  if (!surfaceHit || !diagramState.damageTypes.some((type) => type.id === typeId)) return false;
  addMark(typeId, surfaceHit);
  return true;
}

view.addEventListener("inspection:state", (event) => {
  diagramState = event.detail;
  renderDamageMarks();
});
renderer.domElement.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener("pointermove", (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
  theta -= dx * 0.009;
  phi = THREE.MathUtils.clamp(phi - dy * 0.006, 0.38, 1.48);
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  placeCamera();
  scheduleRender();
});
renderer.domElement.addEventListener("pointerup", (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  const wasMoved = pointer.moved;
  pointer = null;
  if (wasMoved) return;
  const { hits } = coordinatesAt(event.clientX, event.clientY);
  const marker = hits.find((hit) => hit.object.userData.markId);
  if (marker && !diagramState.selectedTypeId) {
    view.dispatchEvent(new CustomEvent("inspection:delete-mark", {
      detail: { id: marker.object.userData.markId },
    }));
    return;
  }
  if (!diagramState.selectedTypeId) return;
  const surfaceHit = hits.find((hit) => surfaceMeshes.includes(hit.object));
  if (!surfaceHit) {
    view.querySelector(".inspection-car-hint").textContent = "損傷位置を記録するには車体表面までアイコンをドラッグしてください。";
    return;
  }
  addMark(diagramState.selectedTypeId, surfaceHit);
});
renderer.domElement.addEventListener("pointercancel", () => { pointer = null; });

window.RentalCarInspection3D = { placeAt };
if (window.__rentalcarInspectionState) {
  diagramState = window.__rentalcarInspectionState;
  renderDamageMarks();
}

function resize() {
  const width = Math.max(view.clientWidth, 1);
  const height = Math.max(view.clientHeight, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  scheduleRender();
}
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(view);
resize();
placeCamera();
view.querySelector(".inspection-car-loading").remove();
