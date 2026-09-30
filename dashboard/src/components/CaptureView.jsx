import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'

export default function CaptureView({ captureRef }) {
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    if (!captureRef) return
    captureRef.current = () => new Promise((resolve, reject) => {
      gl.render(scene, camera)
      gl.domElement.toBlob(blob => {
        if (blob) resolve(blob)
        else reject(new Error('Could not capture this view. Please try again.'))
      }, 'image/png')
    })
    return () => { captureRef.current = null }
  }, [gl, scene, camera, captureRef])
  return null
}
