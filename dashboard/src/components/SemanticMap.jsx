import { useLayoutEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Edges } from '@react-three/drei'
import { Color, Object3D } from 'three'
import { layerColor } from '../palette'
import { buildScene } from '../scene'
import SceneCamera from './SceneCamera'
import { DRIVABILITY_COLORS } from '../drivability'
import EgoVehicle from './EgoVehicle'
import CaptureView from './CaptureView'

// Pixel-width outlines stay crisp as the user zooms, without extra draw calls.
function outlineShader(shader) {
  shader.vertexShader = shader.vertexShader.replace('#include <common>',
    '#include <common>\nvarying vec3 vBlockPosition;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBlockPosition = position;')
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
    '#include <common>\nvarying vec3 vBlockPosition;')
    .replace('#include <dithering_fragment>', `
      vec3 blockDistances = (vec3(0.5) - abs(vBlockPosition)) / max(fwidth(vBlockPosition), vec3(0.00001));
      float blockEdge = min(max(blockDistances.x, blockDistances.y),
        min(max(blockDistances.y, blockDistances.z), max(blockDistances.z, blockDistances.x)));
      gl_FragColor.rgb *= mix(0.48, 1.0, smoothstep(0.45, 1.15, blockEdge));
      #include <dithering_fragment>
    `)
}

const plainShader = () => {}

function Blocks({ parts, hiddenClasses, mode, boundaries, onSelect, selected, view }) {
  const mesh = useRef()
  const visible = useMemo(() => parts.filter(p => !hiddenClasses.has(p.source.semantic_class)), [parts, hiddenClasses])
  const selectedPart = visible.find(part => part.selection === selected)
  useLayoutEffect(() => {
    const object = new Object3D(), color = new Color()
    visible.forEach((part, i) => {
      object.position.set(part.x, part.z, -part.y)
      object.rotation.set(0, part.angle ?? 0, 0)
      const gap = boundaries && !part.finish ? .98 : 1
      object.scale.set(part.sx * gap, part.sy, part.sz * gap)
      object.updateMatrix()
      mesh.current.setMatrixAt(i, object.matrix)
      let paint = layerColor(part.source, mode, [view.low, view.high])
      if (mode === 'semantic' && part.finish === 'glass') paint = '#264858'
      if (mode === 'semantic' && part.finish === 'tire') paint = '#152330'
      color.set(paint)
      if (mode === 'semantic' && !part.finish) {
        color.multiplyScalar(.90 + ((Math.floor(part.x * 7) ^ Math.floor(part.y * 11)) & 7) * .014)
      }
      mesh.current.setColorAt(i, color)
    })
    mesh.current.count = visible.length
    mesh.current.instanceMatrix.needsUpdate = true
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true
    mesh.current.computeBoundingSphere()
  }, [visible, mode, boundaries, view])
  return <>
    <instancedMesh ref={mesh} args={[null, null, Math.max(1, parts.length)]}
      onClick={e => { e.stopPropagation(); onSelect(visible[e.instanceId]?.selection ?? null) }}>
      <boxGeometry />
      {mode === 'drivability'
        ? <meshBasicMaterial key={`drive-${boundaries}`} toneMapped={false} onBeforeCompile={boundaries ? outlineShader : plainShader} />
        : <meshStandardMaterial key={String(boundaries)} roughness={1} metalness={0}
          onBeforeCompile={boundaries ? outlineShader : plainShader} />}
    </instancedMesh>
    {selectedPart && <mesh position={[selectedPart.x, selectedPart.z, -selectedPart.y]}
      rotation={[0, selectedPart.angle ?? 0, 0]} scale={[selectedPart.sx + .025, selectedPart.sy + .025, selectedPart.sz + .025]}>
      <boxGeometry />
      <meshBasicMaterial visible={false} />
      <Edges color="#ffffff" />
    </mesh>}
  </>
}

export default function SemanticMap({ cells, hiddenClasses, mode, boundaries, elevated, topDown, reset,
  onSelect, captureRef, representation, view, selected, zoom, onZoomChange, ego, playing }) {
  const parts = useMemo(() => buildScene(cells, view, { representation: mode === 'drivability' ? 'cells' : representation, elevated }),
    [cells, view, representation, elevated, mode])
  return <Canvas frameloop="demand" dpr={[1, 2]} gl={{ antialias: true }} onPointerMissed={() => onSelect(null)}>
    <color attach="background" args={[mode === 'drivability' ? DRIVABILITY_COLORS.unknown : '#06111c']} />
    <SceneCamera {...{ view, topDown, reset, zoom, onZoomChange }} inset={145} />
    <hemisphereLight args={['#e2f4ff', '#354755', 1.6]} />
    <directionalLight position={[-35, 60, 25]} intensity={2.5} />
    <directionalLight position={[25, 15, -30]} intensity={.45} color="#9bcce3" />
    <Blocks {...{ parts, hiddenClasses, mode, boundaries, onSelect, selected, view }} />
    <EgoVehicle {...{ ego, playing }} />
    <gridHelper args={[Math.max(view.width, view.depth) * 1.5, 24, '#204051', '#112939']}
      position={[view.x, view.low - .35, -view.y]} />
    <CaptureView captureRef={captureRef} />
  </Canvas>
}
