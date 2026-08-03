import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const loader = new GLTFLoader()
const fileUrl = new URL('file:///C:/Users/TOP/Documents/Game/backroom/gamebackrooms/poppy_playtime_chapter_5__lewis.glb')
const gltf = await loader.loadAsync(fileUrl.href)

function logNode(node, depth = 0) {
  const indent = '  '.repeat(depth)
  const p = node.position
  const r = node.rotation
  const s = node.scale
  console.log(`${indent}${node.type} | ${node.name || '(no-name)'} | pos=(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}) rot=(${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)}) scale=(${s.x.toFixed(3)},${s.y.toFixed(3)},${s.z.toFixed(3)})`)
  for (const child of node.children) logNode(child, depth + 1)
}

const scene = gltf.scene
scene.updateWorldMatrix(true, true)
const box = new THREE.Box3().setFromObject(scene)
const size = box.getSize(new THREE.Vector3())
const center = box.getCenter(new THREE.Vector3())
console.log('original bbox min', box.min.toArray())
console.log('original bbox max', box.max.toArray())
console.log('original size', size.toArray())
console.log('original center', center.toArray())

const axes = [
  { name: 'none', apply: (obj) => obj },
  { name: 'rotX-90', apply: (obj) => { obj.rotation.x = -Math.PI / 2; return obj } },
  { name: 'rotY-90', apply: (obj) => { obj.rotation.y = -Math.PI / 2; return obj } },
  { name: 'rotZ-90', apply: (obj) => { obj.rotation.z = -Math.PI / 2; return obj } },
]

for (const option of axes) {
  const clone = scene.clone(true)
  const root = new THREE.Group()
  option.apply(clone)
  root.add(clone)
  root.updateWorldMatrix(true, true)
  const b = new THREE.Box3().setFromObject(root)
  const sz = b.getSize(new THREE.Vector3())
  console.log(option.name, 'size', sz.toArray(), 'min', b.min.toArray(), 'max', b.max.toArray())
}

logNode(scene)
