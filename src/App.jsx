import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useGraph, useThree } from '@react-three/fiber'
import { Clone, PointerLockControls, useGLTF } from '@react-three/drei'
import { io } from 'socket.io-client'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

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
const SECOND_MONSTER_ASSET_URL = new URL(
  '../captain_clark_backrooms-transformed.glb',
  import.meta.url,
).href
const PLAYER_SKIN_ASSET_URL = new URL(
  '../poppy_playtime_chapter_5__lewis-transformed.glb',
  import.meta.url,
).href
const PLAYER_SKIN_BASE_SCALE = 0.1
const PLAYER_SKIN_WORLD_SCALE = 0.1
const MONSTER_SYNC_INTERVAL_MS = 80
const NAVIGATION_HEIGHT = 1
const MULTIPLAYER_API_URL =
  `${import.meta.env.VITE_API_URL ?? ''}`.trim() || 'https://gamebackroomsapi.onrender.com'
const preparedRoomCache = new Map()
const sceneTemplateCache = new Map()
const monsterTemplateCache = new Map()

useGLTF.preload(ROOM_ASSET_URL)
useGLTF.preload(SECOND_ROOM_ASSET_URL)
useGLTF.preload(MONSTER_ASSET_URL)
useGLTF.preload(SECOND_MONSTER_ASSET_URL)
useGLTF.preload(PLAYER_SKIN_ASSET_URL)

function getRequestedRoomCode() {
  if (typeof window === 'undefined') {
    return ''
  }

  return normalizeRoomCode(new URLSearchParams(window.location.search).get('room'))
}

function normalizeRoomCode(value) {
  return `${value ?? ''}`
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)
}

function syncRoomCodeInUrl(roomCode) {
  if (typeof window === 'undefined' || !roomCode) {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set('room', roomCode)
  window.history.replaceState({}, '', url)
}

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
  let hasSkinnedMesh = false
  scene.traverse((child) => {
    if (child.isSkinnedMesh) {
      hasSkinnedMesh = true
    }
  })

  const clone = hasSkinnedMesh ? cloneSkeleton(scene) : scene.clone(true)
  clone.traverse((child) => {
    if (!child.isMesh) {
      return
    }

    child.castShadow = true
    child.receiveShadow = true
    child.frustumCulled = false
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material]
    const nextMaterials = materials.map((material) => {
      const nextMaterial = material.clone()
      nextMaterial.emissive = new THREE.Color('#000000')
      nextMaterial.emissiveIntensity = 0
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

function createMonsterInstance(assetUrl, scene) {
  const template = getMonsterTemplate(assetUrl, scene)
  let hasSkinnedMesh = false
  template.traverse((child) => {
    if (child.isSkinnedMesh) {
      hasSkinnedMesh = true
    }
  })

  return hasSkinnedMesh ? cloneSkeleton(template) : template.clone(true)
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

function scoreMonsterSpawnCandidate(candidate, playerSpawn, size, occupiedPositions = []) {
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

  const targetDistance = THREE.MathUtils.clamp(Math.min(size.x, size.z) * 0.18, 8, 14)

  return (
    -Math.abs(distanceFromPlayerSpawn - targetDistance) * 1.6 +
    Math.min(nearestOccupiedDistance, 10) * 1.4 +
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

  const minimumMonsterDistance = Math.max(Math.min(size.x, size.z) * 0.11, 5.5)
  const maximumMonsterDistance = Math.max(Math.min(size.x, size.z) * 0.3, 16)
  const viableCandidates = navigation.candidates.filter((candidate) => {
    const distanceFromPlayerSpawn = Math.hypot(
      candidate.x - playerSpawn.x,
      candidate.z - playerSpawn.z,
    )

    if (
      distanceFromPlayerSpawn < minimumMonsterDistance ||
      distanceFromPlayerSpawn > maximumMonsterDistance
    ) {
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
      scoreMonsterSpawnCandidate(right, playerSpawn, size, occupiedPositions) -
      scoreMonsterSpawnCandidate(left, playerSpawn, size, occupiedPositions),
  )
  const selectionPool = rankedPool.slice(0, Math.min(8, rankedPool.length))
  const randomIndex = Math.floor(Math.random() * selectionPool.length)
  const selected = selectionPool[randomIndex] ?? rankedPool[0]

  return {
    x: selected?.x ?? playerSpawn.x,
    y: 0,
    z: selected?.z ?? playerSpawn.z,
  }
}

function pickMonsterSpawns(navigation, playerSpawn, size) {
  const firstSpawn = pickRandomMonsterSpawn(navigation, playerSpawn, size)
  let secondSpawn = pickRandomMonsterSpawn(navigation, playerSpawn, size, [firstSpawn])
  const minimumPairDistance = Math.max(Math.min(size.x, size.z) * 0.18, 6.25)

  if (
    Math.hypot(firstSpawn.x - secondSpawn.x, firstSpawn.z - secondSpawn.z) < minimumPairDistance &&
    navigation.candidates.length > 1
  ) {
    const fallbackCandidate = [...navigation.candidates]
      .sort((left, right) => {
        const leftScore =
          Math.hypot(left.x - playerSpawn.x, left.z - playerSpawn.z) +
          Math.hypot(left.x - firstSpawn.x, left.z - firstSpawn.z) * 1.8
        const rightScore =
          Math.hypot(right.x - playerSpawn.x, right.z - playerSpawn.z) +
          Math.hypot(right.x - firstSpawn.x, right.z - firstSpawn.z) * 1.8

        return rightScore - leftScore
      })[0]

    if (fallbackCandidate) {
      secondSpawn = {
        x: fallbackCandidate.x,
        y: 0,
        z: fallbackCandidate.z,
      }
    }
  }

  return { firstSpawn, secondSpawn }
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
  players,
  localPlayerId,
  playerPositionRef,
  onCatch,
  initialSpawn,
  isMobile,
  authoritative,
  networkState,
  otherMonsterState,
  onStateChange,
  monsterId,
}) {
  const gltf = useGLTF(assetUrl)
  const groupRef = useRef()
  const monsterPositionRef = useRef(
    new THREE.Vector3(roomData.bounds.minX + 1.4, 0, roomData.bounds.minZ + 1.4),
  )
  const monsterRotationRef = useRef(0)
  const syncAccumulatorRef = useRef(0)
  const monsterInstance = useMemo(
    () => createMonsterInstance(assetUrl, gltf.scene),
    [assetUrl, gltf.scene],
  )

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
    const nextSpawn = networkState?.position ?? initialSpawn
    monsterPositionRef.current.set(
      nextSpawn.x,
      nextSpawn.y ?? 0,
      nextSpawn.z,
    )
    monsterRotationRef.current = Number.isFinite(networkState?.rotation) ? networkState.rotation : 0
    syncAccumulatorRef.current = 0
    if (groupRef.current) {
      groupRef.current.position.copy(monsterPositionRef.current)
      groupRef.current.rotation.set(0, monsterRotationRef.current, 0)
    }
  }, [initialSpawn.x, initialSpawn.y, initialSpawn.z, networkState?.position, networkState?.rotation, roomData])

  useFrame((state, delta) => {
    if (!active || !groupRef.current) {
      return
    }

    const current = monsterPositionRef.current
    const localPlayer = playerPositionRef.current
    const desiredStep = Math.min(delta * (isMobile ? 1.65 : 1.5), isMobile ? 0.058 : 0.045)
    const localDistanceToPlayer = Math.hypot(localPlayer.x - current.x, localPlayer.z - current.z)

    if (localDistanceToPlayer < 1.15) {
      onCatch()
      return
    }

    if (authoritative) {
      const targetPlayers =
        (players ?? []).filter(
          (player) =>
            player?.position &&
            player.roomKey === 'main' &&
            (player.phase === 'playing' || player.id === localPlayerId),
        ) ?? []

      const targetPlayer =
        targetPlayers.reduce((closest, player) => {
          const candidateDistance = Math.hypot(
            player.position.x - current.x,
            player.position.z - current.z,
          )
          if (!closest || candidateDistance < closest.distance) {
            return { player, distance: candidateDistance }
          }
          return closest
        }, null)?.player ?? { position: localPlayer }

      const dx = targetPlayer.position.x - current.x
      const dz = targetPlayer.position.z - current.z
      const distanceToTarget = Math.hypot(dx, dz)

      if (distanceToTarget > 0.001) {
        let dirX = dx / distanceToTarget
        let dirZ = dz / distanceToTarget

        if (otherMonsterState?.position) {
          const otherDx = current.x - otherMonsterState.position.x
          const otherDz = current.z - otherMonsterState.position.z
          const otherDistance = Math.hypot(otherDx, otherDz)
          const minSeparation = 2.4

          if (otherDistance < minSeparation && otherDistance > 0.001) {
            const repelStrength = (minSeparation - otherDistance) / minSeparation
            dirX += (otherDx / otherDistance) * repelStrength * 1.35
            dirZ += (otherDz / otherDistance) * repelStrength * 1.35
            const dirLength = Math.hypot(dirX, dirZ)
            if (dirLength > 0.001) {
              dirX /= dirLength
              dirZ /= dirLength
            }
          }
        }

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
        monsterRotationRef.current = Math.atan2(
          targetPlayer.position.x - current.x,
          targetPlayer.position.z - current.z,
        )
      }

      syncAccumulatorRef.current += delta * 1000
      if (syncAccumulatorRef.current >= MONSTER_SYNC_INTERVAL_MS) {
        syncAccumulatorRef.current = 0
        onStateChange?.({
          id: monsterId,
          assetUrl,
          position: { x: current.x, y: 0, z: current.z },
          rotation: monsterRotationRef.current,
        })
      }
    } else if (networkState?.position) {
      current.x = THREE.MathUtils.lerp(current.x, networkState.position.x, 0.18)
      current.z = THREE.MathUtils.lerp(current.z, networkState.position.z, 0.18)
      monsterRotationRef.current = THREE.MathUtils.lerp(
        monsterRotationRef.current,
        Number.isFinite(networkState.rotation) ? networkState.rotation : monsterRotationRef.current,
        0.18,
      )
    }

    groupRef.current.position.set(
      current.x,
      Math.sin(state.clock.getElapsedTime() * 3.2) * 0.035,
      current.z,
    )
    groupRef.current.rotation.y = monsterRotationRef.current
  })

  return (
    <group ref={groupRef}>
      <primitive object={monsterInstance} position={monsterScale.offset} scale={monsterScale.scale} />
      <pointLight
        color="#fff0c2"
        intensity={
          assetUrl === SECOND_MONSTER_ASSET_URL
            ? isMobile
              ? 1.55
              : 2.3
            : isMobile
              ? 1.2
              : 1.8
        }
        distance={assetUrl === SECOND_MONSTER_ASSET_URL ? (isMobile ? 7.2 : 9.8) : isMobile ? 6.2 : 8.4}
        decay={2}
        position={[0, 1.25, 0]}
      />
    </group>
  )
}

function LewisPlayerModel() {
  const { scene } = useGLTF(PLAYER_SKIN_ASSET_URL)
  const clone = useMemo(() => cloneSkeleton(scene), [scene])
  const { nodes, materials } = useGraph(clone)

  if (!nodes?._rootJoint || !nodes?.Object_168?.geometry || !nodes?.Object_168?.skeleton) {
    return (
      <primitive
        object={clone}
        rotation={[-Math.PI / 2, Math.PI, 0]}
        scale={PLAYER_SKIN_BASE_SCALE * PLAYER_SKIN_WORLD_SCALE}
      />
    )
  }

  return (
    <group dispose={null} rotation={[0, Math.PI, 0]} scale={PLAYER_SKIN_WORLD_SCALE}>
      <primitive object={nodes._rootJoint} />
      <skinnedMesh
        castShadow
        receiveShadow
        geometry={nodes.Object_168.geometry}
        material={materials.HazmatSuitMat ?? nodes.Object_168.material}
        skeleton={nodes.Object_168.skeleton}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={PLAYER_SKIN_BASE_SCALE}
      />
    </group>
  )
}

function MultiplayerMarker({ player, isLocal }) {
  const groupRef = useRef()
  const targetPosition = useMemo(() => new THREE.Vector3(), [])
  const currentPosition = useMemo(() => new THREE.Vector3(), [])
  const yBobOffset = useRef(Math.random() * Math.PI * 2)
  const currentRotationY = useRef(player.rotation?.y ?? 0)

  useEffect(() => {
    targetPosition.set(player.position.x, 0, player.position.z)
    if (!groupRef.current) {
      currentPosition.copy(targetPosition)
      return
    }

    if (isLocal) {
      currentPosition.copy(targetPosition)
      groupRef.current.position.copy(targetPosition)
    }
  }, [currentPosition, isLocal, player.position.x, player.position.z, targetPosition])

  useFrame(({ clock }, delta) => {
    if (!groupRef.current) {
      return
    }

    const targetRotationY = player.rotation?.y ?? 0

    if (isLocal) {
      currentRotationY.current = targetRotationY
      groupRef.current.position.set(
        targetPosition.x,
        Math.sin(clock.getElapsedTime() * 2.6 + yBobOffset.current) * 0.006,
        targetPosition.z,
      )
      groupRef.current.rotation.y = currentRotationY.current
      return
    }

    currentPosition.lerp(targetPosition, THREE.MathUtils.clamp(delta * 9, 0.08, 0.35))
    currentRotationY.current = THREE.MathUtils.lerp(
      currentRotationY.current,
      targetRotationY,
      THREE.MathUtils.clamp(delta * 10, 0.08, 0.35),
    )
    groupRef.current.position.set(
      currentPosition.x,
      Math.sin(clock.getElapsedTime() * 2.6 + yBobOffset.current) * 0.006,
      currentPosition.z,
    )
    groupRef.current.rotation.y = currentRotationY.current
  })

  const color = isLocal ? '#79fff7' : '#ff6fae'

  return (
    <group ref={groupRef}>
      {!isLocal && <LewisPlayerModel />}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.18, 0.33, 28]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} />
      </mesh>
      <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.08, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} />
      </mesh>
    </group>
  )
}

function MultiplayerMarkers({ active, players, localPlayerId, roomKey }) {
  const visiblePlayers = useMemo(
    () =>
      (players ?? []).filter(
        (player) =>
          player?.position &&
          player.roomKey === roomKey &&
          (player.phase === 'playing' || player.id === localPlayerId),
      ),
    [localPlayerId, players, roomKey],
  )

  if (!active || visiblePlayers.length === 0) {
    return null
  }

  return visiblePlayers.map((player) => (
    <MultiplayerMarker
      key={player.id}
      player={player}
      isLocal={player.id === localPlayerId}
    />
  ))
}

function PlayerController({
  active,
  roomData,
  playerPositionRef,
  runId,
  initialLookTarget,
  isMobile,
  mobileControlsRef,
  onPlayerStateChange,
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
  const lastReportRef = useRef(0)

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
    onPlayerStateChange?.({
      position: {
        x: roomData.spawn.x,
        y: roomData.spawn.y,
        z: roomData.spawn.z,
      },
      rotation: {
        x: camera.rotation.x,
        y: camera.rotation.y,
        z: camera.rotation.z,
      },
    })
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

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now - lastReportRef.current >= 55) {
      lastReportRef.current = now
      onPlayerStateChange?.({
        position: {
          x: nextPosition.x,
          y: nextPosition.y,
          z: nextPosition.z,
        },
        rotation: {
          x: camera.rotation.x,
          y: camera.rotation.y,
          z: camera.rotation.z,
        },
      })
    }
  })

  return isMobile ? null : <PointerLockControls selector="#game-shell" />
}

function BackroomsScene({
  active,
  onCaught,
  onTraverse,
  roomKey,
  runId,
  isMobile,
  mobileControlsRef,
  players,
  localPlayerId,
  isHost,
  monsterState,
  onMonsterStateChange,
  onPlayerStateChange,
  onBoundsChange,
}) {
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
    return pickMonsterSpawns(roomData.navigation, roomData.spawn, roomData.size)
  }, [roomData, roomKey, runId])
  const secondMonsterAssetUrl = SECOND_MONSTER_ASSET_URL
  const defaultMonsterState = useMemo(
    () => ({
      roomKey,
      runId,
      monsters:
        roomKey === 'main'
          ? [
              {
                id: 'monster-1',
                assetUrl: MONSTER_ASSET_URL,
                position: monsterSpawns.firstSpawn,
                rotation: 0,
              },
              {
                id: 'monster-2',
                assetUrl: secondMonsterAssetUrl,
                position: monsterSpawns.secondSpawn,
                rotation: 0,
              },
            ]
          : [],
    }),
    [monsterSpawns.firstSpawn, monsterSpawns.secondSpawn, roomKey, runId, secondMonsterAssetUrl],
  )
  const sharedMonsterState =
    monsterState?.roomKey === roomKey && monsterState?.runId === runId
      ? monsterState
      : defaultMonsterState
  const sharedMonsters = sharedMonsterState.monsters ?? []
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

  useEffect(() => {
    onBoundsChange?.(roomData.bounds)
  }, [onBoundsChange, roomData.bounds])

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

  useEffect(() => {
    if (!active || !isHost) {
      return
    }

    const isOutdated =
      monsterState?.roomKey !== roomKey ||
      monsterState?.runId !== runId ||
      (roomKey === 'main' && (monsterState?.monsters?.length ?? 0) < 2)

    if (isOutdated) {
      onMonsterStateChange?.(defaultMonsterState)
    }
  }, [active, defaultMonsterState, isHost, monsterState, onMonsterStateChange, roomKey, runId])

  const handleMonsterStateChange = (monsterSnapshot) => {
    if (!isHost) {
      return
    }

    const nextMonsters = sharedMonsters.map((monster) =>
      monster.id === monsterSnapshot.id ? { ...monster, ...monsterSnapshot } : monster,
    )

    onMonsterStateChange?.({
      roomKey,
      runId,
      monsters: nextMonsters,
    })
  }

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
              players={players}
              localPlayerId={localPlayerId}
              playerPositionRef={playerPositionRef}
              onCatch={onCaught}
              initialSpawn={sharedMonsters[0]?.position ?? monsterSpawns.firstSpawn}
              isMobile={isMobile}
              authoritative={isHost}
              networkState={sharedMonsters[0]}
              otherMonsterState={sharedMonsters[1]}
              onStateChange={handleMonsterStateChange}
              monsterId="monster-1"
            />
          </Suspense>
          <Suspense fallback={null}>
            <MonsterChaser
              active={active}
              assetUrl={secondMonsterAssetUrl}
              roomData={roomData}
              players={players}
              localPlayerId={localPlayerId}
              playerPositionRef={playerPositionRef}
              onCatch={onCaught}
              initialSpawn={sharedMonsters[1]?.position ?? monsterSpawns.secondSpawn}
              isMobile={isMobile}
              authoritative={isHost}
              networkState={sharedMonsters[1]}
              otherMonsterState={sharedMonsters[0]}
              onStateChange={handleMonsterStateChange}
              monsterId="monster-2"
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
      <Suspense fallback={null}>
        <MultiplayerMarkers
          active={active}
          players={players}
          localPlayerId={localPlayerId}
          roomKey={roomKey}
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
        onPlayerStateChange={onPlayerStateChange}
      />
    </>
  )
}

function MobileControls({ active, mobileControlsRef }) {
  const [moveThumb, setMoveThumb] = useState({ x: 0, y: 0 })
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

  const startLook = (event) => {
    if (event.target.closest('.mobile-pad, .mobile-actions')) {
      return
    }

    lookPointerIdRef.current = event.pointerId
    lookLastRef.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveLook = (event) => {
    if (lookPointerIdRef.current !== event.pointerId) {
      return
    }

    mobileControlsRef.current.lookX += event.clientX - lookLastRef.current.x
    mobileControlsRef.current.lookY += event.clientY - lookLastRef.current.y
    lookLastRef.current = { x: event.clientX, y: event.clientY }
  }

  const endLook = (event) => {
    if (lookPointerIdRef.current !== event.pointerId) {
      return
    }

    event.currentTarget.releasePointerCapture(event.pointerId)
    lookPointerIdRef.current = null
  }

  return (
    <div
      className={`mobile-ui ${active ? '' : 'mobile-ui-hidden'}`}
      onPointerDown={startLook}
      onPointerMove={moveLook}
      onPointerUp={endLook}
      onPointerCancel={endLook}
    >
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
    </div>
  )
}

function useMultiplayerRoom({ phase, roomKey, runId, localPlayerState }) {
  const [room, setRoom] = useState(null)
  const [availableRooms, setAvailableRooms] = useState([])
  const [localPlayerId, setLocalPlayerId] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('connecting')
  const [connectionError, setConnectionError] = useState('')
  const [requestedRoomCode, setRequestedRoomCode] = useState(() => getRequestedRoomCode())
  const roomCodeRef = useRef(getRequestedRoomCode())
  const socketRef = useRef(null)
  const playerNameRef = useRef(`Jugador ${Math.floor(100 + Math.random() * 900)}`)

  useEffect(() => {
    if (typeof window === 'undefined' || !MULTIPLAYER_API_URL) {
      return undefined
    }

    const socket = io(MULTIPLAYER_API_URL, {
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    const handleConnect = () => {
      setConnectionStatus('ready')
      setConnectionError('')
    }

    const handleAssigned = ({ playerId, roomCode }) => {
      setLocalPlayerId(playerId)
      roomCodeRef.current = roomCode
      setRequestedRoomCode(roomCode)
      syncRoomCodeInUrl(roomCode)
    }

    const handleRoomState = (nextRoom) => {
      setRoom(nextRoom)
      setConnectionStatus('connected')
      setConnectionError('')
    }

    const handleRoomList = (rooms) => {
      setAvailableRooms(Array.isArray(rooms) ? rooms : [])
    }

    const handlePlayerUpdated = (player) => {
      setRoom((currentRoom) => {
        if (!currentRoom) {
          return currentRoom
        }

        return {
          ...currentRoom,
          players: currentRoom.players.map((currentPlayer) =>
            currentPlayer.id === player.id ? { ...currentPlayer, ...player } : currentPlayer,
          ),
        }
      })
    }

    const handlePlayerJoined = (player) => {
      setRoom((currentRoom) => {
        if (!currentRoom) {
          return currentRoom
        }

        const players = currentRoom.players.filter((currentPlayer) => currentPlayer.id !== player.id)
        return {
          ...currentRoom,
          players: [...players, player],
        }
      })
    }

    const handlePlayerLeft = ({ playerId }) => {
      setRoom((currentRoom) => {
        if (!currentRoom) {
          return currentRoom
        }

        return {
          ...currentRoom,
          players: currentRoom.players.filter((player) => player.id !== playerId),
        }
      })
    }

    const handleRoomError = ({ message }) => {
      setConnectionStatus('ready')
      setConnectionError(message ?? 'No se pudo conectar a la sala.')
    }

    const handleMonstersState = (nextMonsterState) => {
      setRoom((currentRoom) => {
        if (!currentRoom) {
          return currentRoom
        }

        return {
          ...currentRoom,
          monsterState: nextMonsterState,
        }
      })
    }

    const handleDisconnect = () => {
      setConnectionStatus('disconnected')
    }

    const handleConnectError = () => {
      setConnectionStatus('error')
      setConnectionError('No se pudo conectar con la API multijugador.')
    }

    socket.on('connect', handleConnect)
    socket.on('player:assigned', handleAssigned)
    socket.on('room:state', handleRoomState)
    socket.on('room:list', handleRoomList)
    socket.on('player:updated', handlePlayerUpdated)
    socket.on('player:joined', handlePlayerJoined)
    socket.on('player:left', handlePlayerLeft)
    socket.on('monsters:state', handleMonstersState)
    socket.on('room:error', handleRoomError)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect_error', handleConnectError)

    return () => {
      socket.emit('room:leave')
      socket.off('connect', handleConnect)
      socket.off('player:assigned', handleAssigned)
      socket.off('room:state', handleRoomState)
      socket.off('room:list', handleRoomList)
      socket.off('player:updated', handlePlayerUpdated)
      socket.off('player:joined', handlePlayerJoined)
      socket.off('player:left', handlePlayerLeft)
      socket.off('monsters:state', handleMonstersState)
      socket.off('room:error', handleRoomError)
      socket.off('disconnect', handleDisconnect)
      socket.off('connect_error', handleConnectError)
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket || connectionStatus !== 'connected') {
      return
    }

    socket.emit('player:update', {
      phase,
      roomKey,
      position: localPlayerState.position,
      rotation: localPlayerState.rotation,
    })
  }, [connectionStatus, localPlayerState.position, localPlayerState.rotation, phase, roomKey])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket || connectionStatus !== 'connected' || !localPlayerId || room?.hostPlayerId !== localPlayerId) {
      return
    }

    socket.emit('room:update', {
      phase: phase === 'intro' ? 'lobby' : phase,
      roomKey,
      runId,
    })
  }, [connectionStatus, localPlayerId, phase, room?.hostPlayerId, roomKey, runId])

  const createRoom = () =>
    new Promise((resolve) => {
      const socket = socketRef.current
      if (!socket?.connected) {
        setConnectionStatus('error')
        setConnectionError('La API multijugador todavía no está lista.')
        resolve(false)
        return
      }

      setConnectionStatus('joining')
      setConnectionError('')
      socket.emit('room:create', { playerName: playerNameRef.current }, (response) => {
        if (!response?.ok) {
          setConnectionStatus('ready')
          setConnectionError('No se pudo crear la sala.')
          resolve(false)
          return
        }

        resolve(true)
      })
    })

  const joinRoom = (roomCode) =>
    new Promise((resolve) => {
      const socket = socketRef.current
      const normalizedRoomCode = normalizeRoomCode(roomCode)

      if (!normalizedRoomCode) {
        setConnectionError('Ingresa un código de sala válido.')
        resolve(false)
        return
      }

      if (!socket?.connected) {
        setConnectionStatus('error')
        setConnectionError('La API multijugador todavía no está lista.')
        resolve(false)
        return
      }

      setConnectionStatus('joining')
      setConnectionError('')
      setRequestedRoomCode(normalizedRoomCode)
      socket.emit(
        'room:join',
        { roomCode: normalizedRoomCode, playerName: playerNameRef.current },
        (response) => {
          if (!response?.ok) {
            setConnectionStatus('ready')
            resolve(false)
            return
          }

          resolve(true)
        },
      )
    })

  const updateMonsters = (nextMonsterState) => {
    const socket = socketRef.current
    if (!socket || connectionStatus !== 'connected' || !localPlayerId || room?.hostPlayerId !== localPlayerId) {
      return
    }

    socket.emit('monsters:update', nextMonsterState)
  }

  return {
    room,
    availableRooms,
    localPlayerId,
    roomCode: room?.code ?? roomCodeRef.current,
    connectionStatus,
    connectionError,
    requestedRoomCode,
    setRequestedRoomCode,
    createRoom,
    joinRoom,
    updateMonsters,
  }
}

function RoomMinimap({ players, localPlayerId, roomKey, bounds, roomCode, connectionStatus }) {
  const visiblePlayers = (players ?? []).filter(
    (player) => player?.position && player.roomKey === roomKey,
  )
  const spanX = Math.max((bounds?.maxX ?? 10) - (bounds?.minX ?? -10), 1)
  const spanZ = Math.max((bounds?.maxZ ?? 10) - (bounds?.minZ ?? -10), 1)

  const points = visiblePlayers.map((player) => {
    const normalizedX = ((player.position.x - (bounds?.minX ?? -10)) / spanX) * 100
    const normalizedY = 100 - ((player.position.z - (bounds?.minZ ?? -10)) / spanZ) * 100

    return {
      id: player.id,
      x: THREE.MathUtils.clamp(normalizedX, 6, 94),
      y: THREE.MathUtils.clamp(normalizedY, 6, 94),
      color: player.id === localPlayerId ? '#79fff7' : '#ff6fae',
      isLocal: player.id === localPlayerId,
    }
  })

  return (
    <div className="minimap-shell">
      <svg className="minimap" viewBox="0 0 100 100" aria-label="Posicion de jugadores">
        <rect x="2" y="2" width="96" height="96" rx="14" fill="rgba(12, 12, 8, 0.72)" />
        {points.map((point) => (
          <circle
            key={point.id}
            cx={point.x}
            cy={point.y}
            r={point.isLocal ? 4.8 : 4.2}
            fill={point.color}
            stroke="rgba(255, 248, 213, 0.9)"
            strokeWidth="1.2"
          />
        ))}
      </svg>
    </div>
  )
}

export default function App() {
  const [phase, setPhase] = useState('intro')
  const [runId, setRunId] = useState(0)
  const [roomKey, setRoomKey] = useState('main')
  const [roomBounds, setRoomBounds] = useState({
    minX: -12,
    maxX: 12,
    minZ: -12,
    maxZ: 12,
  })
  const [localPlayerState, setLocalPlayerState] = useState({
    position: { x: 0, y: PLAYER_HEIGHT, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  })
  const isMobile = useIsMobileDevice()
  const mobileControlsRef = useRef({
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    running: false,
  })
  const active = phase === 'playing'
  const {
    room,
    availableRooms,
    localPlayerId,
    roomCode,
    connectionStatus,
    connectionError,
    requestedRoomCode,
    setRequestedRoomCode,
    createRoom,
    joinRoom,
    updateMonsters,
  } = useMultiplayerRoom({ phase, roomKey, runId, localPlayerState })
  const roomPlayers = useMemo(() => {
    const players = room?.players ?? []

    return players.map((player) =>
      player.id === localPlayerId
        ? {
            ...player,
            position: localPlayerState.position,
            rotation: localPlayerState.rotation,
            roomKey,
            phase,
          }
        : player,
    )
  }, [localPlayerId, localPlayerState.position, localPlayerState.rotation, phase, room?.players, roomKey])
  const hasOtherPlayer = roomPlayers.some((player) => player.id !== localPlayerId)
  const roomPresenceText =
    active && connectionStatus === 'connected' && !hasOtherPlayer ? 'Esperando a otro jugador' : ''
  const sessionBusy = connectionStatus === 'connecting' || connectionStatus === 'joining'

  useBackgroundMusic(phase !== 'intro')

  useEffect(() => {
    if (!active) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      useGLTF.preload(SECOND_ROOM_ASSET_URL)
      useGLTF.preload(SECOND_MONSTER_ASSET_URL)
      useGLTF.preload(PLAYER_SKIN_ASSET_URL)
    }, isMobile ? 400 : 1200)

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
          players={roomPlayers}
          localPlayerId={localPlayerId}
          isHost={room?.hostPlayerId === localPlayerId}
          monsterState={room?.monsterState}
          onMonsterStateChange={updateMonsters}
          onBoundsChange={setRoomBounds}
          onPlayerStateChange={setLocalPlayerState}
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

      {roomPresenceText ? (
        <div className="hud">
          <div className="hud-chip">{roomPresenceText}</div>
        </div>
      ) : null}

      <RoomMinimap
        players={roomPlayers}
        localPlayerId={localPlayerId}
        roomKey={roomKey}
        bounds={roomBounds}
        roomCode={roomCode}
        connectionStatus={connectionStatus}
      />

      {!isMobile && <div className="crosshair" />}

      <div className={`overlay ${active ? 'overlay-hidden' : ''}`}>
        <div className="overlay-card">
          <p className="eyebrow">Backrooms</p>
          <h1>{phase === 'lost' ? 'La criatura te encontró' : 'Bienvenido a Backrooms'}</h1>
          {phase === 'lost' && (
            <p>
              Las criaturas de Backrooms te alcanzaron dentro de la sala. Vuelve a entrar y sigue corriendo.
            </p>
          )}
          {phase === 'lost' ? (
            <button
              className="start-button"
              type="button"
              onClick={() => {
                setRoomKey('main')
                setRunId((value) => value + 1)
                setPhase('playing')
              }}
            >
              Volver a entrar
            </button>
          ) : (
            <>
              <p className="session-status">{roomPresenceText}</p>
              <label className="room-input-label" htmlFor="room-code">
                Código de sala
              </label>
              <input
                id="room-code"
                className="room-input"
                type="text"
                inputMode="text"
                maxLength={6}
                autoComplete="off"
                value={requestedRoomCode}
                onChange={(event) => {
                  setRequestedRoomCode(normalizeRoomCode(event.target.value))
                }}
                onKeyDown={async (event) => {
                  if (event.key !== 'Enter' || sessionBusy) {
                    return
                  }

                  const joined = await joinRoom(requestedRoomCode)
                  if (joined) {
                    setRoomKey('main')
                    setRunId((value) => value + 1)
                    setPhase('playing')
                  }
                }}
                placeholder="Ejemplo: AB12CD"
              />
              <div className="session-actions">
                <button
                  className="start-button secondary-button"
                  type="button"
                  disabled={sessionBusy}
                  onClick={async () => {
                    const created = await createRoom()
                    if (created) {
                      setRoomKey('main')
                      setRunId((value) => value + 1)
                      setPhase('playing')
                    }
                  }}
                >
                  Crear sala
                </button>
                <button
                  className="start-button"
                  type="button"
                  disabled={sessionBusy}
                  onClick={async () => {
                    const joined = await joinRoom(requestedRoomCode)
                    if (joined) {
                      setRoomKey('main')
                      setRunId((value) => value + 1)
                      setPhase('playing')
                    }
                  }}
                >
                  Unirme
                </button>
              </div>
              <div className="room-list">
                <div className="room-list-header">
                  <span>Partidas disponibles</span>
                  <span>{availableRooms.length}</span>
                </div>
                {availableRooms.length === 0 ? (
                  <p className="room-list-empty">No hay salas abiertas todavía.</p>
                ) : (
                  availableRooms.map((availableRoom) => (
                    <button
                      key={availableRoom.code}
                      className="room-list-item"
                      type="button"
                      disabled={sessionBusy}
                      onClick={async () => {
                        const joined = await joinRoom(availableRoom.code)
                        if (joined) {
                          setRoomKey('main')
                          setRunId((value) => value + 1)
                          setPhase('playing')
                        }
                      }}
                    >
                      <span className="room-list-code">{availableRoom.code}</span>
                      <span className="room-list-meta">
                        {availableRoom.hostPlayerName} · {availableRoom.playerCount}/
                        {availableRoom.playerLimit}
                      </span>
                    </button>
                  ))
                )}
              </div>
              {connectionError ? <p className="session-error">{connectionError}</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
