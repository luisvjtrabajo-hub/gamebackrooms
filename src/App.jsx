import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Clone, PointerLockControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'

const PLAYER_HEIGHT = 1.65
const PLAYER_PADDING = 1.8
const PLAYER_RADIUS = 0.28
const MOBILE_BREAKPOINT = 900
const MOBILE_LOOK_SENSITIVITY = 0.0032
const BACKGROUND_MUSIC_URL = new URL('../musica.mp3', import.meta.url).href
const ROOM_ASSET_URL = new URL('../backrooms_another_level.glb', import.meta.url).href
const SECOND_ROOM_ASSET_URL = new URL(
  '../rec_room_-_backrooms_level_you_cheated.glb',
  import.meta.url,
).href
const MONSTER_ASSET_URL = new URL('../backrooms_monster.glb', import.meta.url).href
const SECOND_MONSTER_ASSET_URL = new URL('../captain_clark_backrooms.glb', import.meta.url).href
const NAVIGATION_HEIGHT = 1
const preparedRoomCache = new Map()
const sceneTemplateCache = new Map()
const monsterTemplateCache = new Map()

useGLTF.preload(ROOM_ASSET_URL)
useGLTF.preload(MONSTER_ASSET_URL)
useGLTF.preload(SECOND_MONSTER_ASSET_URL)

function useIsMobileDevice() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return (
      window.matchMedia('(pointer: coarse)').matches ||
      window.innerWidth <= MOBILE_BREAKPOINT
    )
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const mediaQuery = window.matchMedia('(pointer: coarse)')
    const update = () => {
      setIsMobile(mediaQuery.matches || window.innerWidth <= MOBILE_BREAKPOINT)
    }

    update()
    mediaQuery.addEventListener('change', update)
    window.addEventListener('resize', update)

    return () => {
      mediaQuery.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return isMobile
}

function useBackgroundMusic(enabled) {
  const audioRef = useRef(null)
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    if (!audioRef.current) {
      const audio = new window.Audio(BACKGROUND_MUSIC_URL)
      audio.loop = true
      audio.preload = 'none'
      audio.playsInline = true
      audio.volume = 0.38
      audioRef.current = audio
    }

    const audio = audioRef.current

    if (enabled) {
      const playPromise = audio.play()
      if (playPromise?.catch) {
        playPromise.catch(() => {})
      }
    } else {
      audio.pause()
      audio.currentTime = 0
    }

    return undefined
  }, [enabled])

  useEffect(() => {
    return () => {
      if (!audioRef.current) {
        return
      }

      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current.load()
      audioRef.current = null
    }
  }, [])
}

function createSceneTemplate(scene) {
  const clone = scene.clone(true)
  return clone
}

function createMonsterTemplate(scene) {
  const clone = scene.clone(true)
  clone.traverse((child) => {
    if (!child.isMesh) {
      return
    }

    child.castShadow = true
    child.receiveShadow = true
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material]
    const nextMaterials = materials.map((material) => {
      const nextMaterial = material.clone()
      nextMaterial.emissive = new THREE.Color('#250018')
      nextMaterial.emissiveIntensity = 0.35
      nextMaterial.roughness = 0.82
      return nextMaterial
    })
    child.material = nextMaterials.length === 1 ? nextMaterials[0] : nextMaterials
  })
  return clone
}

function getSceneTemplate(assetUrl, scene) {
  if (!sceneTemplateCache.has(assetUrl)) {
    sceneTemplateCache.set(assetUrl, createSceneTemplate(scene))
  }

  return sceneTemplateCache.get(assetUrl)
}

function getMonsterTemplate(assetUrl, scene) {
  if (!monsterTemplateCache.has(assetUrl)) {
    monsterTemplateCache.set(assetUrl, createMonsterTemplate(scene))
  }

  return monsterTemplateCache.get(assetUrl)
}

function resolveRoomPoint(bounds, hint) {
  if (!hint) {
    return { x: 0, z: 0 }
  }

  if (typeof hint.x === 'number' && typeof hint.z === 'number') {
    return hint
  }

  const xRatio = THREE.MathUtils.clamp(hint.xRatio ?? 0, -1, 1)
  const zRatio = THREE.MathUtils.clamp(hint.zRatio ?? 0, -1, 1)
  const xCenter = (bounds.minX + bounds.maxX) / 2
  const zCenter = (bounds.minZ + bounds.maxZ) / 2
  const xHalfSpan = (bounds.maxX - bounds.minX) / 2
  const zHalfSpan = (bounds.maxZ - bounds.minZ) / 2

  return {
    x: xCenter + xHalfSpan * xRatio,
    z: zCenter + zHalfSpan * zRatio,
  }
}

function buildNavigationData({ scene, offset, bounds, size, coarse = false }) {
  const probeRoot = new THREE.Group()
  const probeScene = scene.clone(true)
  probeRoot.add(probeScene)
  probeScene.position.set(offset[0], offset[1], offset[2])
  probeRoot.updateWorldMatrix(true, true)

  const raycaster = new THREE.Raycaster()
  const collisionNormal = new THREE.Vector3()
  const directions = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(1, 0, 1).normalize(),
    new THREE.Vector3(1, 0, -1).normalize(),
    new THREE.Vector3(-1, 0, 1).normalize(),
    new THREE.Vector3(-1, 0, -1).normalize(),
  ]
  const step = coarse
    ? THREE.MathUtils.clamp(Math.min(size.x, size.z) / 24, 0.72, 0.9)
    : THREE.MathUtils.clamp(Math.min(size.x, size.z) / 34, 0.52, 0.68)
  const maxProbeDistance = THREE.MathUtils.clamp(step * (coarse ? 3.7 : 4.2), 2.2, 4.2)
  const columns = Math.floor((bounds.maxX - bounds.minX) / step) + 1
  const rows = Math.floor((bounds.maxZ - bounds.minZ) / step) + 1
  const walkable = new Uint8Array(columns * rows)
  const candidates = []

  for (let column = 0; column < columns; column += 1) {
    const x = bounds.minX + column * step
    for (let row = 0; row < rows; row += 1) {
      const z = bounds.minZ + row * step
      const origin = new THREE.Vector3(x, NAVIGATION_HEIGHT, z)
      let minDistance = Infinity
      let score = 0
      let blocked = false

      for (const direction of directions) {
        raycaster.set(origin, direction)
        raycaster.far = maxProbeDistance

        const hit = raycaster.intersectObject(probeRoot, true).find((intersection) => {
          if (!intersection.face || intersection.distance < 0.02) {
            return false
          }

          collisionNormal
            .copy(intersection.face.normal)
            .transformDirection(intersection.object.matrixWorld)

          return Math.abs(collisionNormal.y) < 0.45
        })

        const distance = hit ? hit.distance : maxProbeDistance
        minDistance = Math.min(minDistance, distance)
        score += distance
      }

      if (minDistance < PLAYER_RADIUS + (coarse ? 0.22 : 0.16)) {
        blocked = true
      }

      const index = row * columns + column
      if (!blocked) {
        walkable[index] = 1
        candidates.push({ x, z, score })
      }
    }
  }

  return {
    originX: bounds.minX,
    originZ: bounds.minZ,
    step,
    columns,
    rows,
    walkable,
    candidates,
  }
}

function isWalkablePosition(navigation, x, z, radius = PLAYER_RADIUS) {
  const sampleRadius = radius * 0.68
  const sampleOffsets = [
    [0, 0],
    [sampleRadius, 0],
    [-sampleRadius, 0],
    [0, sampleRadius],
    [0, -sampleRadius],
  ]

  return sampleOffsets.every(([offsetX, offsetZ]) => {
    const sampleX = x + offsetX
    const sampleZ = z + offsetZ
    const column = Math.round((sampleX - navigation.originX) / navigation.step)
    const row = Math.round((sampleZ - navigation.originZ) / navigation.step)

    if (
      column < 0 ||
      row < 0 ||
      column >= navigation.columns ||
      row >= navigation.rows
    ) {
      return false
    }

    return navigation.walkable[row * navigation.columns + column] === 1
  })
}

function clampInput(value) {
  return THREE.MathUtils.clamp(value, -1, 1)
}

function scoreMonsterSpawnCandidate(candidate, playerSpawn, occupiedPositions = []) {
  const distanceFromPlayerSpawn = Math.hypot(
    candidate.x - playerSpawn.x,
    candidate.z - playerSpawn.z,
  )
  const nearestOccupiedDistance = occupiedPositions.reduce((best, position) => {
    if (!position) {
      return best
    }

    return Math.min(best, Math.hypot(candidate.x - position.x, candidate.z - position.z))
  }, Infinity)

  return (
    distanceFromPlayerSpawn * 1.35 +
    Math.min(nearestOccupiedDistance, 14) * 1.8 +
    candidate.score * 0.08
  )
}

function pickRandomMonsterSpawn(navigation, playerSpawn, size, occupiedPositions = []) {
  if (navigation.candidates.length === 0) {
    return {
      x: playerSpawn.x,
      y: 0,
      z: playerSpawn.z,
    }
  }

  const minimumMonsterDistance = Math.max(Math.min(size.x, size.z) * 0.24, 7.5)
  const viableCandidates = navigation.candidates.filter((candidate) => {
    const distanceFromPlayerSpawn = Math.hypot(
      candidate.x - playerSpawn.x,
      candidate.z - playerSpawn.z,
    )

    if (distanceFromPlayerSpawn < minimumMonsterDistance) {
      return false
    }

    return occupiedPositions.every((position) => {
      if (!position) {
        return true
      }

      return Math.hypot(candidate.x - position.x, candidate.z - position.z) >= 5.5
    })
  })

  const pool = viableCandidates.length > 0 ? viableCandidates : navigation.candidates
  const rankedPool = [...pool].sort(
    (left, right) =>
      scoreMonsterSpawnCandidate(right, playerSpawn, occupiedPositions) -
      scoreMonsterSpawnCandidate(left, playerSpawn, occupiedPositions),
  )
  const selectionPool = rankedPool.slice(0, Math.min(6, rankedPool.length))
  const randomIndex = Math.floor(Math.random() * selectionPool.length)
  const selected = selectionPool[randomIndex] ?? rankedPool[0]

  return {
    x: selected?.x ?? playerSpawn.x,
    y: 0,
    z: selected?.z ?? playerSpawn.z,
  }
}

function findNavigationAnchors({
  navigation,
  size,
  preferredSpawn,
  preferredMonsterSpawn,
}) {
  const { candidates } = navigation

  if (candidates.length === 0) {
    return {
      spawn: {
        x: 0,
        y: PLAYER_HEIGHT,
        z: size.z / 2 - Math.max(PLAYER_PADDING, size.z * 0.08) - Math.max(1.2, size.z * 0.04),
      },
      monsterSpawn: {
        x: preferredMonsterSpawn.x,
        y: 0,
        z: preferredMonsterSpawn.z,
      },
    }
  }

  const spawnCandidate = candidates.reduce((best, candidate) => {
    const bestDistance = Math.hypot(best.x - preferredSpawn.x, best.z - preferredSpawn.z)
    const candidateDistance = Math.hypot(
      candidate.x - preferredSpawn.x,
      candidate.z - preferredSpawn.z,
    )
    const bestRank = best.score - bestDistance * 3.5
    const candidateRank = candidate.score - candidateDistance * 3.5

    return candidateRank > bestRank ? candidate : best
  }, candidates[0])

  const minimumMonsterDistance = Math.max(Math.min(size.x, size.z) * 0.22, 6)
  const viableMonsterCandidates = candidates.filter((candidate) => {
    const distanceFromSpawn = Math.hypot(
      candidate.x - spawnCandidate.x,
      candidate.z - spawnCandidate.z,
    )

    return distanceFromSpawn >= minimumMonsterDistance
  })

  const monsterPool = viableMonsterCandidates.length > 0 ? viableMonsterCandidates : candidates
  const monsterCandidate = monsterPool.reduce((best, candidate) => {
    const bestDistanceFromSpawn = Math.hypot(
      best.x - spawnCandidate.x,
      best.z - spawnCandidate.z,
    )
    const candidateDistanceFromSpawn = Math.hypot(
      candidate.x - spawnCandidate.x,
      candidate.z - spawnCandidate.z,
    )
    const bestDistanceFromHint = Math.hypot(
      best.x - preferredMonsterSpawn.x,
      best.z - preferredMonsterSpawn.z,
    )
    const candidateDistanceFromHint = Math.hypot(
      candidate.x - preferredMonsterSpawn.x,
      candidate.z - preferredMonsterSpawn.z,
    )
    const bestRank =
      bestDistanceFromSpawn * 1.2 + best.score * 0.1 - bestDistanceFromHint * 2.6
    const candidateRank =
      candidateDistanceFromSpawn * 1.2 +
      candidate.score * 0.1 -
      candidateDistanceFromHint * 2.6

    return candidateRank > bestRank ? candidate : best
  }, monsterPool[0])

  return {
    spawn: {
      x: spawnCandidate.x,
      y: PLAYER_HEIGHT,
      z: spawnCandidate.z,
    },
    monsterSpawn: {
      x: monsterCandidate.x,
      y: 0,
      z: monsterCandidate.z,
    },
  }
}

function prepareRoomData(assetUrl, scene, isMobile) {
  const cacheKey = `${assetUrl}:${isMobile ? 'mobile' : 'desktop'}`

  if (preparedRoomCache.has(cacheKey)) {
    return preparedRoomCache.get(cacheKey)
  }

  const box = new THREE.Box3().setFromObject(scene)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const paddingX = Math.max(PLAYER_PADDING, size.x * 0.08)
  const paddingZ = Math.max(PLAYER_PADDING, size.z * 0.08)
  const visualRadius = Math.max(size.x, size.y, size.z)
  const offset = [-center.x, -box.min.y, -center.z]
  const bounds = {
    minX: -size.x / 2 + paddingX,
    maxX: size.x / 2 - paddingX,
    minZ: -size.z / 2 + paddingZ,
    maxZ: size.z / 2 - paddingZ,
  }
  const prepared = {
    template: getSceneTemplate(assetUrl, scene),
    offset,
    scale: 1,
    size,
    visualRadius,
    bounds,
    navigation: buildNavigationData({
      scene,
      offset,
      bounds,
      size,
      coarse: isMobile,
    }),
  }

  preparedRoomCache.set(cacheKey, prepared)
  return prepared
}

function useRoomData(assetUrl, preferredSpawn, preferredMonsterSpawn, isMobile) {
  const gltf = useGLTF(assetUrl)

  return useMemo(() => {
    const prepared = prepareRoomData(assetUrl, gltf.scene, isMobile)
    const resolvedPreferredSpawn = resolveRoomPoint(prepared.bounds, preferredSpawn)
    const resolvedPreferredMonsterSpawn = resolveRoomPoint(
      prepared.bounds,
      preferredMonsterSpawn,
    )
    const anchors = findNavigationAnchors({
      navigation: prepared.navigation,
      size: prepared.size,
      preferredSpawn: resolvedPreferredSpawn,
      preferredMonsterSpawn: resolvedPreferredMonsterSpawn,
    })

    return {
      ...prepared,
      spawn: anchors.spawn,
      monsterSpawn: anchors.monsterSpawn,
    }
  }, [
    assetUrl,
    gltf.scene,
    isMobile,
    preferredMonsterSpawn.xRatio,
    preferredMonsterSpawn.zRatio,
    preferredMonsterSpawn.x,
    preferredMonsterSpawn.z,
    preferredSpawn.xRatio,
    preferredSpawn.zRatio,
    preferredSpawn.x,
    preferredSpawn.z,
  ])
}

function MainRoom({ roomData, roomRef }) {
  const { template, offset } = roomData

  return (
    <group ref={roomRef} position={[0, 0, 0]}>
      <Clone object={template} position={offset} scale={roomData.scale} />
    </group>
  )
}

function DoorPortal({ position, color = '#70fff4' }) {
  const ringRef = useRef()
  const panelRef = useRef()

  useFrame(({ clock }) => {
    const pulse = 0.78 + Math.sin(clock.getElapsedTime() * 2.8) * 0.18
    if (ringRef.current) {
      ringRef.current.rotation.y += 0.01
    }
    if (panelRef.current) {
      panelRef.current.material.opacity = 0.22 + pulse * 0.18
    }
  })

  return (
    <group position={[position.x, 0, position.z]}>
      <mesh position={[0, 1.55, 0.04]} ref={panelRef}>
        <planeGeometry args={[1.45, 2.9]} />
        <meshBasicMaterial color={color} transparent opacity={0.32} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 1.55, 0]} ref={ringRef}>
        <torusGeometry args={[0.92, 0.07, 14, 36]} />
        <meshStandardMaterial color="#f7fffd" emissive={color} emissiveIntensity={1.6} />
      </mesh>
      <mesh position={[0, 1.55, -0.12]}>
        <boxGeometry args={[1.68, 3.18, 0.12]} />
        <meshStandardMaterial color="#141414" emissive={color} emissiveIntensity={0.42} />
      </mesh>
      <pointLight
        position={[0, 1.6, 0.45]}
        color={color}
        intensity={3.4}
        distance={8}
        decay={1.8}
      />
      <mesh position={[0, 3.45, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.34, 0.52, 28]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} />
      </mesh>
    </group>
  )
}

function MonsterChaser({
  active,
  assetUrl,
  roomData,
  playerPositionRef,
  onCatch,
  runId,
  initialSpawn,
  isMobile,
}) {
  const gltf = useGLTF(assetUrl)
  const groupRef = useRef()
  const monsterPositionRef = useRef(
    new THREE.Vector3(roomData.bounds.minX + 1.4, 0, roomData.bounds.minZ + 1.4),
  )
  const template = useMemo(() => getMonsterTemplate(assetUrl, gltf.scene), [assetUrl, gltf.scene])

  const monsterScale = useMemo(() => {
    const box = new THREE.Box3().setFromObject(gltf.scene)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const scale = Math.min(
      Math.max(roomData.size.x * 0.035, 1.1) / Math.max(size.x, 0.1),
      Math.max(roomData.size.y * 0.52, 2.2) / Math.max(size.y, 0.1),
      Math.max(roomData.size.z * 0.035, 1.1) / Math.max(size.z, 0.1),
    )

    return {
      scale,
      offset: [-center.x * scale, -box.min.y * scale, -center.z * scale],
    }
  }, [gltf.scene, roomData.size.x, roomData.size.y, roomData.size.z])

  useEffect(() => {
    monsterPositionRef.current.set(
      initialSpawn.x,
      initialSpawn.y,
      initialSpawn.z,
    )
    if (groupRef.current) {
      groupRef.current.position.copy(monsterPositionRef.current)
      groupRef.current.rotation.set(0, 0, 0)
    }
  }, [initialSpawn.x, initialSpawn.y, initialSpawn.z, roomData, runId])

  useFrame((state, delta) => {
    if (!active || !groupRef.current) {
      return
    }

    const current = monsterPositionRef.current
    const player = playerPositionRef.current
    const desiredStep = Math.min(delta * 2.2, 0.08)
    const dx = player.x - current.x
    const dz = player.z - current.z
    const distanceToPlayer = Math.hypot(dx, dz)

    if (distanceToPlayer < 1.15) {
      onCatch()
      return
    }

    if (distanceToPlayer > 0.001) {
      const dirX = dx / distanceToPlayer
      const dirZ = dz / distanceToPlayer

      const targetX = THREE.MathUtils.clamp(
        current.x + dirX * desiredStep,
        roomData.bounds.minX,
        roomData.bounds.maxX,
      )
      const targetZ = THREE.MathUtils.clamp(
        current.z + dirZ * desiredStep,
        roomData.bounds.minZ,
        roomData.bounds.maxZ,
      )

      let resolvedX = current.x
      let resolvedZ = current.z

      if (isWalkablePosition(roomData.navigation, targetX, resolvedZ, PLAYER_RADIUS * 1.05)) {
        resolvedX = targetX
      }

      if (isWalkablePosition(roomData.navigation, resolvedX, targetZ, PLAYER_RADIUS * 1.05)) {
        resolvedZ = targetZ
      }

      current.set(resolvedX, 0, resolvedZ)
      groupRef.current.rotation.y = Math.atan2(player.x - current.x, player.z - current.z)
    }

    groupRef.current.position.set(
      current.x,
      Math.sin(state.clock.getElapsedTime() * 3.2) * 0.06,
      current.z,
    )
  })

  return (
    <group ref={groupRef}>
      <Clone object={template} position={monsterScale.offset} scale={monsterScale.scale} />
      {!isMobile && (
        <pointLight
          color="#7d173f"
          intensity={3.2}
          distance={10}
          decay={2}
          position={[0, 1.2, 0]}
        />
      )}
    </group>
  )
}

function PlayerController({
  active,
  roomData,
  playerPositionRef,
  runId,
  initialLookTarget,
  isMobile,
  mobileControlsRef,
}) {
  const { camera } = useThree()
  const keys = useRef({})
  const forward = useMemo(() => new THREE.Vector3(), [])
  const right = useMemo(() => new THREE.Vector3(), [])
  const nextPosition = useMemo(() => new THREE.Vector3(), [])
  const walkingRef = useRef(0)
  const lookTarget = useMemo(() => new THREE.Vector3(), [])
  const yawRef = useRef(0)
  const pitchRef = useRef(0)

  useEffect(() => {
    playerPositionRef.current.set(roomData.spawn.x, roomData.spawn.y, roomData.spawn.z)
    camera.position.copy(playerPositionRef.current)
    lookTarget.set(initialLookTarget.x, PLAYER_HEIGHT, initialLookTarget.z)
    camera.lookAt(lookTarget)
    yawRef.current = camera.rotation.y
    pitchRef.current = camera.rotation.x
    if (isMobile) {
      camera.rotation.order = 'YXZ'
    }
  }, [camera, initialLookTarget.x, initialLookTarget.z, isMobile, lookTarget, roomData, runId])

  useEffect(() => {
    const handleKeyDown = (event) => {
      keys.current[event.code] = true
    }
    const handleKeyUp = (event) => {
      keys.current[event.code] = false
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  useFrame((_, delta) => {
    if (!active) {
      return
    }

    const mobileControls = mobileControlsRef.current
    const inputX = clampInput(
      (keys.current.KeyD ? 1 : 0) -
        (keys.current.KeyA ? 1 : 0) +
        (isMobile ? mobileControls.moveX : 0),
    )
    const inputZ = clampInput(
      (keys.current.KeyW ? 1 : 0) -
        (keys.current.KeyS ? 1 : 0) +
        (isMobile ? mobileControls.moveY : 0),
    )
    const isRunning =
      keys.current.ShiftLeft ||
      keys.current.ShiftRight ||
      (isMobile && mobileControls.running)
    const speed = isRunning ? (isMobile ? 3.9 : 4.8) : isMobile ? 2.45 : 3

    if (isMobile) {
      yawRef.current -= mobileControls.lookX * MOBILE_LOOK_SENSITIVITY
      pitchRef.current = THREE.MathUtils.clamp(
        pitchRef.current - mobileControls.lookY * MOBILE_LOOK_SENSITIVITY,
        -1.12,
        1.12,
      )
      mobileControls.lookX = 0
      mobileControls.lookY = 0
      camera.rotation.order = 'YXZ'
      camera.rotation.y = yawRef.current
      camera.rotation.x = pitchRef.current
    }

    camera.getWorldDirection(forward)
    forward.y = 0
    forward.normalize()
    right.crossVectors(forward, camera.up).normalize()

    nextPosition.copy(playerPositionRef.current)
    if (inputZ !== 0 || inputX !== 0) {
      nextPosition
        .addScaledVector(forward, inputZ * speed * delta)
        .addScaledVector(right, inputX * speed * delta)
    }

    const clampedX = THREE.MathUtils.clamp(
      nextPosition.x,
      roomData.bounds.minX,
      roomData.bounds.maxX,
    )
    const clampedZ = THREE.MathUtils.clamp(
      nextPosition.z,
      roomData.bounds.minZ,
      roomData.bounds.maxZ,
    )

    let resolvedX = playerPositionRef.current.x
    let resolvedZ = playerPositionRef.current.z

    if (isWalkablePosition(roomData.navigation, clampedX, resolvedZ)) {
      resolvedX = clampedX
    }

    if (isWalkablePosition(roomData.navigation, resolvedX, clampedZ)) {
      resolvedZ = clampedZ
    }

    nextPosition.set(resolvedX, PLAYER_HEIGHT, resolvedZ)
    playerPositionRef.current.copy(nextPosition)

    const movementAmount = Math.hypot(
      nextPosition.x - camera.position.x,
      nextPosition.z - camera.position.z,
    )

    if (movementAmount > 0.001) {
      walkingRef.current += delta * (isRunning ? 12 : 7)
    }

    camera.position.x = nextPosition.x
    camera.position.z = nextPosition.z
    camera.position.y =
      PLAYER_HEIGHT + Math.sin(walkingRef.current) * Math.min(0.05, movementAmount * 0.22)
  })

  return isMobile ? null : <PointerLockControls selector="#game-shell" />
}

function BackroomsScene({ active, onCaught, onTraverse, roomKey, runId, isMobile, mobileControlsRef }) {
  const roomPreset =
    roomKey === 'main'
      ? {
          assetUrl: ROOM_ASSET_URL,
          preferredSpawn: { xRatio: 0.34, zRatio: 0.28 },
          preferredMonsterSpawn: { xRatio: -0.14, zRatio: -0.08 },
          preferredLookTarget: { xRatio: -0.16, zRatio: -0.08 },
          nextRoom: 'secondary',
          roomLabel: 'Sala Grande',
          portalColor: '#79fff7',
        }
      : {
          assetUrl: SECOND_ROOM_ASSET_URL,
          preferredSpawn: { x: 0, z: 0 },
          preferredMonsterSpawn: { x: 0, z: 0 },
          preferredLookTarget: { x: 0, z: 0 },
          nextRoom: 'main',
          roomLabel: 'Sala Secreta',
          portalColor: '#f2d76a',
        }

  const roomData = useRoomData(
    roomPreset.assetUrl,
    roomPreset.preferredSpawn,
    roomPreset.preferredMonsterSpawn,
    isMobile,
  )
  const roomRef = useRef()
  const playerPositionRef = useRef(new THREE.Vector3(0, PLAYER_HEIGHT, 0))
  const lastTraverseRef = useRef(-100)
  const { camera } = useThree()
  const lightHeight = Math.max(3.4, roomData.size.y * 0.82)
  const mainLightDistance = Math.max(18, roomData.visualRadius * 0.7)
  const sideLightDistance = Math.max(12, roomData.visualRadius * 0.45)
  const initialLookTarget = useMemo(
    () => resolveRoomPoint(roomData.bounds, roomPreset.preferredLookTarget),
    [roomData.bounds, roomPreset.preferredLookTarget],
  )
  const monsterSpawns = useMemo(() => {
    const firstSpawn = pickRandomMonsterSpawn(
      roomData.navigation,
      roomData.spawn,
      roomData.size,
    )
    const secondSpawn = pickRandomMonsterSpawn(
      roomData.navigation,
      roomData.spawn,
      roomData.size,
      [firstSpawn],
    )

    return { firstSpawn, secondSpawn }
  }, [roomData, roomKey, runId])
  const portalPosition = useMemo(() => {
    if (roomKey === 'main') {
      return {
        x: THREE.MathUtils.clamp(
          roomData.spawn.x + roomData.size.x * 0.16,
          roomData.bounds.minX + 1.2,
          roomData.bounds.maxX - 1.2,
        ),
        z: THREE.MathUtils.clamp(
          roomData.spawn.z - roomData.size.z * 0.14,
          roomData.bounds.minZ + 1.2,
          roomData.bounds.maxZ - 1.2,
        ),
      }
    }

    return {
      x: THREE.MathUtils.clamp(
        roomData.spawn.x - roomData.size.x * 0.14,
        roomData.bounds.minX + 1.2,
        roomData.bounds.maxX - 1.2,
      ),
      z: THREE.MathUtils.clamp(
        roomData.spawn.z + roomData.size.z * 0.12,
        roomData.bounds.minZ + 1.2,
        roomData.bounds.maxZ - 1.2,
      ),
    }
  }, [roomData, roomKey])

  useEffect(() => {
    camera.far = Math.max(100, roomData.visualRadius * 3)
    camera.updateProjectionMatrix()
  }, [camera, roomData.visualRadius])

  useFrame(({ clock }) => {
    if (!active) {
      return
    }

    const distanceToPortal = Math.hypot(
      playerPositionRef.current.x - portalPosition.x,
      playerPositionRef.current.z - portalPosition.z,
    )

    if (distanceToPortal < 1.25 && clock.getElapsedTime() - lastTraverseRef.current > 1.2) {
      lastTraverseRef.current = clock.getElapsedTime()
      onTraverse(roomPreset.nextRoom)
    }
  })

  return (
    <>
      <color attach="background" args={['#141105']} />
      <fogExp2
        attach="fog"
        args={['#6f6928', THREE.MathUtils.clamp(1 / Math.max(roomData.visualRadius * 3, 40), 0.003, 0.018)]}
      />
      <ambientLight intensity={0.4} color="#9c9141" />
      {isMobile ? null : (
        <>
          <pointLight
            position={[-roomData.size.x * 0.22, lightHeight * 0.96, roomData.size.z * 0.18]}
            intensity={4.2}
            distance={sideLightDistance}
            decay={2}
            color="#f4eba8"
          />
          <pointLight
            position={[roomData.size.x * 0.22, lightHeight * 0.96, -roomData.size.z * 0.18]}
            intensity={4.2}
            distance={sideLightDistance}
            decay={2}
            color="#efe18e"
          />
        </>
      )}

      <pointLight
        position={[0, lightHeight, 0]}
        intensity={isMobile ? 5.4 : 7}
        distance={mainLightDistance}
        decay={1.8}
        color="#fff1a8"
      />

      <Suspense fallback={null}>
        <MainRoom roomData={roomData} roomRef={roomRef} />
      </Suspense>
      {roomKey === 'main' && (
        <>
          <Suspense fallback={null}>
            <MonsterChaser
              active={active}
              assetUrl={MONSTER_ASSET_URL}
              roomData={roomData}
              playerPositionRef={playerPositionRef}
              onCatch={onCaught}
              runId={runId}
              initialSpawn={monsterSpawns.firstSpawn}
              isMobile={isMobile}
            />
          </Suspense>
          <Suspense fallback={null}>
            <MonsterChaser
              active={active}
              assetUrl={SECOND_MONSTER_ASSET_URL}
              roomData={roomData}
              playerPositionRef={playerPositionRef}
              onCatch={onCaught}
              runId={runId}
              initialSpawn={monsterSpawns.secondSpawn}
              isMobile={isMobile}
            />
          </Suspense>
        </>
      )}
      <Suspense fallback={null}>
        <DoorPortal
          position={portalPosition}
          color={roomPreset.portalColor}
        />
      </Suspense>

      <PlayerController
        active={active}
        roomData={roomData}
        playerPositionRef={playerPositionRef}
        runId={runId}
        initialLookTarget={initialLookTarget}
        isMobile={isMobile}
        mobileControlsRef={mobileControlsRef}
      />
    </>
  )
}

function MobileControls({ active, mobileControlsRef }) {
  const [moveThumb, setMoveThumb] = useState({ x: 0, y: 0 })
  const [lookActive, setLookActive] = useState(false)
  const movePointerIdRef = useRef(null)
  const lookPointerIdRef = useRef(null)
  const lookLastRef = useRef({ x: 0, y: 0 })
  const moveBoundsRef = useRef(null)
  const maxRadius = 42

  useEffect(() => {
    if (active) {
      return undefined
    }

    mobileControlsRef.current.moveX = 0
    mobileControlsRef.current.moveY = 0
    mobileControlsRef.current.lookX = 0
    mobileControlsRef.current.lookY = 0
    mobileControlsRef.current.running = false
    setMoveThumb({ x: 0, y: 0 })
    setLookActive(false)
    return undefined
  }, [active, mobileControlsRef])

  const resetMovement = () => {
    movePointerIdRef.current = null
    mobileControlsRef.current.moveX = 0
    mobileControlsRef.current.moveY = 0
    setMoveThumb({ x: 0, y: 0 })
  }

  const updateMovement = (event) => {
    if (!moveBoundsRef.current) {
      return
    }

    const centerX = moveBoundsRef.current.left + moveBoundsRef.current.width / 2
    const centerY = moveBoundsRef.current.top + moveBoundsRef.current.height / 2
    const rawX = event.clientX - centerX
    const rawY = event.clientY - centerY
    const distance = Math.hypot(rawX, rawY)
    const scale = distance > maxRadius ? maxRadius / distance : 1
    const x = rawX * scale
    const y = rawY * scale

    setMoveThumb({ x, y })
    mobileControlsRef.current.moveX = x / maxRadius
    mobileControlsRef.current.moveY = -y / maxRadius
  }

  return (
    <div className={`mobile-ui ${active ? '' : 'mobile-ui-hidden'}`}>
      <div
        className="mobile-pad mobile-pad-left"
        onPointerDown={(event) => {
          movePointerIdRef.current = event.pointerId
          moveBoundsRef.current = event.currentTarget.getBoundingClientRect()
          event.currentTarget.setPointerCapture(event.pointerId)
          updateMovement(event)
        }}
        onPointerMove={(event) => {
          if (movePointerIdRef.current !== event.pointerId) {
            return
          }

          updateMovement(event)
        }}
        onPointerUp={(event) => {
          if (movePointerIdRef.current !== event.pointerId) {
            return
          }

          event.currentTarget.releasePointerCapture(event.pointerId)
          resetMovement()
        }}
        onPointerCancel={resetMovement}
      >
        <div className="mobile-pad-ring">
          <div
            className="mobile-pad-thumb"
            style={{ transform: `translate(${moveThumb.x}px, ${moveThumb.y}px)` }}
          />
        </div>
      </div>

      <div className="mobile-actions">
        <button
          className="mobile-run-button"
          type="button"
          onPointerDown={(event) => {
            event.preventDefault()
            mobileControlsRef.current.running = true
          }}
          onPointerUp={() => {
            mobileControlsRef.current.running = false
          }}
          onPointerCancel={() => {
            mobileControlsRef.current.running = false
          }}
          onPointerLeave={() => {
            mobileControlsRef.current.running = false
          }}
        >
          Correr
        </button>
      </div>

      <div
        className={`mobile-look-zone ${lookActive ? 'mobile-look-zone-active' : ''}`}
        onPointerDown={(event) => {
          lookPointerIdRef.current = event.pointerId
          lookLastRef.current = { x: event.clientX, y: event.clientY }
          setLookActive(true)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (lookPointerIdRef.current !== event.pointerId) {
            return
          }

          mobileControlsRef.current.lookX += event.clientX - lookLastRef.current.x
          mobileControlsRef.current.lookY += event.clientY - lookLastRef.current.y
          lookLastRef.current = { x: event.clientX, y: event.clientY }
        }}
        onPointerUp={(event) => {
          if (lookPointerIdRef.current !== event.pointerId) {
            return
          }

          event.currentTarget.releasePointerCapture(event.pointerId)
          lookPointerIdRef.current = null
          setLookActive(false)
        }}
        onPointerCancel={() => {
          lookPointerIdRef.current = null
          setLookActive(false)
        }}
      >
        <span className="mobile-look-label">Desliza para mirar</span>
      </div>
    </div>
  )
}

export default function App() {
  const [phase, setPhase] = useState('intro')
  const [runId, setRunId] = useState(0)
  const [roomKey, setRoomKey] = useState('main')
  const isMobile = useIsMobileDevice()
  const mobileControlsRef = useRef({
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    running: false,
  })
  const active = phase === 'playing'

  useBackgroundMusic(phase !== 'intro')

  useEffect(() => {
    if (!active || isMobile) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      useGLTF.preload(SECOND_ROOM_ASSET_URL)
      useGLTF.preload(SECOND_MONSTER_ASSET_URL)
    }, 2500)

    return () => window.clearTimeout(timer)
  }, [active, isMobile])

  return (
    <div id="game-shell" className={`app-shell phase-${phase}`}>
      <Canvas
        dpr={isMobile ? [0.65, 0.85] : [1, 1.1]}
        performance={{ min: isMobile ? 0.5 : 0.75 }}
        gl={{
          antialias: false,
          powerPreference: 'high-performance',
          alpha: false,
          stencil: false,
        }}
        camera={{ fov: 72, near: 0.1, far: 100, position: [0, PLAYER_HEIGHT, 5.5] }}
      >
        <BackroomsScene
          active={active}
          roomKey={roomKey}
          runId={runId}
          isMobile={isMobile}
          mobileControlsRef={mobileControlsRef}
          onCaught={() => setPhase('lost')}
          onTraverse={(nextRoom) => {
            setRoomKey(nextRoom)
            setRunId((value) => value + 1)
          }}
        />
      </Canvas>

      {!isMobile && <div className="screen-noise" />}
      <div className="danger-vignette" style={{ opacity: active ? 0.24 : 0.42 }} />
      {isMobile && <MobileControls active={active} mobileControlsRef={mobileControlsRef} />}

      <div className="hud">
        <div className="hud-chip">
          Sala: {roomKey === 'main' ? 'Habitación grande' : 'Habitación secreta'}
        </div>
        <div className="hud-chip">{isMobile ? 'Mover: joystick' : 'Mover: W A S D'}</div>
        <div className="hud-chip">{isMobile ? 'Mirar: desliza' : 'Correr: Shift'}</div>
        <div className="hud-chip">Criaturas: {isMobile ? 1 : 2}</div>
        <div className="hud-chip">Cruza la puerta brillante</div>
      </div>

      {!isMobile && <div className="crosshair" />}

      <div className={`overlay ${active ? 'overlay-hidden' : ''}`}>
        <div className="overlay-card">
          <p className="eyebrow">Backrooms</p>
          <h1>{phase === 'lost' ? 'La criatura te encontró' : 'Habitación lista'}</h1>
          <p>
            {phase === 'lost'
              ? 'Las criaturas de Backrooms te alcanzaron dentro de la sala. Vuelve a entrar y sigue corriendo.'
              : 'Quité las paredes sueltas y dejé solo la habitación grande completa para explorarla en primera persona.'}
          </p>
          <ul className="instructions">
            <li>{isMobile ? 'Usa el joystick izquierdo para moverte' : '`W A S D` para moverte'}</li>
            <li>{isMobile ? 'Desliza a la derecha para mirar' : '`Shift` para correr'}</li>
            <li>
              {isMobile
                ? 'Mantén pulsado "Correr" para huir más rápido'
                : 'Haz clic en la escena para capturar el mouse'}
            </li>
          </ul>
          <button
            className="start-button"
            type="button"
            onClick={() => {
              setRoomKey('main')
              setRunId((value) => value + 1)
              setPhase('playing')
            }}
          >
            {phase === 'lost' ? 'Volver a entrar' : 'Entrar a la habitación'}
          </button>
        </div>
      </div>
    </div>
  )
}
