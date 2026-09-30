import { Canvas } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color } from 'three'
import { colorForClass, layerColor } from '../palette'
import { inView } from '../scene'
import SceneCamera from './SceneCamera'
import EgoVehicle from './EgoVehicle'
import CaptureView from './CaptureView'

function roundPoints(shader) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
    'if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;\n#include <alphatest_fragment>')
}

function Cloud({ points, hiddenClasses, mode, view, pointSize }) {
  const geometry = useRef()
  const { positions, colors } = useMemo(() => {
    const positions = [], colors = [], color = new Color()
    for (let i = 0; i < points.length; i += 4) {
      if (hiddenClasses.has(Math.round(points[i + 3])) || !inView(points[i], points[i + 1], view)) continue
      positions.push(points[i], points[i + 2], -points[i + 1])
      color.set(mode === 'height'
        ? layerColor({ elevation: points[i + 2] }, 'elevation', [view.low, view.high])
        : colorForClass(Math.round(points[i + 3])))
      colors.push(color.r, color.g, color.b)
    }
    return { positions: new Float32Array(positions), colors: new Float32Array(colors) }
  }, [points, hiddenClasses, mode, view])
  useLayoutEffect(() => { geometry.current.computeBoundingSphere() }, [positions])
  return <points>
    <bufferGeometry ref={geometry}>
      <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      <bufferAttribute attach="attributes-color" args={[colors, 3]} />
    </bufferGeometry>
    <pointsMaterial size={pointSize} sizeAttenuation={false} vertexColors toneMapped={false}
      onBeforeCompile={roundPoints} />
  </points>
}

export default function PointCloud({ points, hiddenClasses, mode = 'semantic', topDown = false, view, pointSize = 1.8,
  ego, playing, zoom, onZoomChange, captureRef }) {
  return <Canvas frameloop="demand" dpr={[1, 2]} gl={{ antialias: true }}>
    <color attach="background" args={['#040c16']} />
    <SceneCamera {...{ view, topDown, zoom, onZoomChange }} />
    <Cloud {...{ points, hiddenClasses, mode, view, pointSize }} />
    <EgoVehicle {...{ ego, playing }} />
    <CaptureView captureRef={captureRef} />
    <gridHelper args={[Math.max(view.width, view.depth) * 1.4, 20, '#1d3d50', '#102232']}
      position={[view.x, view.low - .3, -view.y]} />
  </Canvas>
}
