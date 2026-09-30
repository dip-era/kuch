import { Html } from '@react-three/drei'
import { EGO_COLOR } from '../ego'

function Part({ position, scale, color }) {
  return <mesh position={position} scale={scale} renderOrder={102}>
    <boxGeometry />
    <meshBasicMaterial color={color} toneMapped={false} depthTest={false} depthWrite={false} />
  </mesh>
}

export default function EgoVehicle({ ego, playing = false }) {
  if (!ego) return null
  return <group position={[ego.x, ego.z, -ego.y]} onClick={event => event.stopPropagation()}>
    <mesh position={[0, .06, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={100}>
      <ringGeometry args={[2.8, 2.91, 64]} />
      <meshBasicMaterial color={EGO_COLOR} transparent opacity={.8} toneMapped={false} depthTest={false} depthWrite={false} />
    </mesh>
    <Part position={[0, .7, 0]} scale={[4.3, .65, 1.8]} color={EGO_COLOR} />
    <Part position={[-.3, 1.28, 0]} scale={[2.1, .6, 1.45]} color="#092633" />
    <Part position={[-.3, 1.62, 0]} scale={[1.95, .08, 1.52]} color={EGO_COLOR} />
    <Part position={[1.5, 1.04, 0]} scale={[.9, .04, .3]} color="#ffffff" />
    {[-1.3, 1.3].flatMap(x => [-.92, .92].map(z =>
      <Part key={`${x}-${z}`} position={[x, .35, z]} scale={[.65, .6, .22]} color="#152532" />))}
    <mesh position={[3.5, .16, 0]} rotation={[0, 0, -Math.PI / 2]} renderOrder={102}>
      <coneGeometry args={[.36, 1, 3]} />
      <meshBasicMaterial color="#ffffff" toneMapped={false} depthTest={false} depthWrite={false} />
    </mesh>
    <Html center position={[0, 2.5, 0]} zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`ego-badge ${playing ? 'is-playing' : ''}`}><i />OUR CAR<span>{playing ? 'PLAYBACK' : 'EGO'}</span></div>
    </Html>
  </group>
}
