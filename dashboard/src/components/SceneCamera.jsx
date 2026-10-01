import { useLayoutEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls, OrthographicCamera } from '@react-three/drei'
import { Vector3 } from 'three'

export default function SceneCamera({ view, topDown, reset = 0, inset = 0, zoom = 1, onZoomChange }) {
  const camera = useRef(), controls = useRef()
  const fittedZoom = useRef(1), zoomValue = useRef(zoom), updating = useRef(false)
  const offsetValue = useRef(null), previousTopDown = useRef(topDown), previousReset = useRef(reset)
  const { size, invalidate, camera: activeCamera } = useThree()
  useLayoutEffect(() => {
    zoomValue.current = zoom
    updating.current = true
    camera.current.zoom = fittedZoom.current * zoom
    camera.current.updateProjectionMatrix()
    controls.current?.update()
    updating.current = false
    invalidate()
  }, [zoom, invalidate])
  useLayoutEffect(() => {
    updating.current = true
    const cam = camera.current
    const span = Math.max(view.width, view.depth)
    const height = topDown ? view.base : (view.low + view.high) / 2
    const target = new Vector3(view.x, height, -view.y)
    const defaultOffset = new Vector3(topDown ? 0 : span * .75, span, topDown ? .001 : span * .85)
    const preserveManualView = offsetValue.current && previousTopDown.current === topDown && previousReset.current === reset
    const offset = preserveManualView ? offsetValue.current.clone() : defaultOffset
    cam.position.copy(target).add(offset)
    cam.lookAt(target)
    cam.updateMatrixWorld()
    let extentX = 0, extentY = 0
    for (const x of [-.5, .5]) for (const y of [-.5, .5]) for (const z of [view.low, view.high]) {
      const corner = new Vector3(view.x + x * view.width, z, -view.y + y * view.depth)
        .applyMatrix4(cam.matrixWorldInverse)
      extentX = Math.max(extentX, Math.abs(corner.x))
      extentY = Math.max(extentY, Math.abs(corner.y))
    }
    const reserved = Math.min(inset, size.width * .25)
    fittedZoom.current = Math.max(.01, .88 * Math.min((size.width - reserved) / Math.max(1, extentX * 2),
      (size.height - 66) / Math.max(1, extentY * 2)))
    cam.zoom = fittedZoom.current * zoomValue.current
    cam.setViewOffset(size.width, size.height, -reserved / 2, 0, size.width, size.height)
    cam.updateProjectionMatrix()
    if (controls.current) {
      if (onZoomChange) {
        controls.current.minZoom = fittedZoom.current * .5
        controls.current.maxZoom = fittedZoom.current * 8
      }
      controls.current.target.copy(target)
      controls.current.update()
    }
    offsetValue.current = cam.position.clone().sub(target)
    previousTopDown.current = topDown
    previousReset.current = reset
    updating.current = false
    invalidate()
  }, [view, topDown, reset, size.width, size.height, inset, invalidate, activeCamera, onZoomChange])
  return <>
    <OrthographicCamera ref={camera} makeDefault near={.01} far={100000} />
    <OrbitControls ref={controls} makeDefault enableDamping={false}
      onChange={() => {
        if (!onZoomChange || updating.current || controls.current?.object !== camera.current) return
        const next = Math.max(.5, Math.min(8, Math.round(camera.current.zoom / fittedZoom.current * 100) / 100))
        if (next !== zoomValue.current) {
          zoomValue.current = next
          onZoomChange(next)
        }
        offsetValue.current = camera.current.position.clone().sub(controls.current.target)
      }}
      minZoom={.01} maxZoom={400} maxPolarAngle={Math.PI / 2.02} />
  </>
}
