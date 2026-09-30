import { useEffect, useRef } from 'react'
import { layerColor } from '../palette'
import { inView } from '../scene'
import { DRIVABILITY_COLORS } from '../drivability'
import { EGO_COLOR } from '../ego'

export default function GridView({ cells, hiddenClasses, mode = 'semantic', boundaries = false, view, ego, zoom = 1, captureRef }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    if (!captureRef) return
    captureRef.current = () => new Promise((resolve, reject) => {
      canvasRef.current.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not capture this map.')), 'image/png')
    })
    return () => { captureRef.current = null }
  }, [captureRef])
  useEffect(() => {
    const canvas = canvasRef.current, context = canvas.getContext('2d')
    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.fillStyle = mode === 'drivability' ? DRIVABILITY_COLORS.unknown : '#06111c'
      context.fillRect(0, 0, rect.width, rect.height)
      const scale = zoom * Math.min((rect.width - 32) / view.width, (rect.height - 54) / view.depth)
      const ox = rect.width / 2 - view.x * scale, oy = (rect.height - 18) / 2 + view.y * scale
      context.strokeStyle = '#173043'; context.lineWidth = .5
      const spacing = Math.max(5, 10 ** Math.floor(Math.log10(view.width / 4)))
      for (let x = Math.ceil((view.x - view.width / 2) / spacing) * spacing; x <= view.x + view.width / 2; x += spacing) {
        context.beginPath(); context.moveTo(ox + x * scale, 12); context.lineTo(ox + x * scale, rect.height - 28); context.stroke()
      }
      for (let y = Math.ceil((view.y - view.depth / 2) / spacing) * spacing; y <= view.y + view.depth / 2; y += spacing) {
        context.beginPath(); context.moveTo(12, oy - y * scale); context.lineTo(rect.width - 12, oy - y * scale); context.stroke()
      }
      for (const c of cells) {
        if (hiddenClasses.has(c.semantic_class) || !inView((c.x_min + c.x_max) / 2, (c.y_min + c.y_max) / 2, view)) continue
        context.fillStyle = layerColor(c, mode, [view.low, view.high])
        const x = ox + c.x_min * scale, y = oy - c.y_max * scale
        const w = Math.max(1 / dpr, (c.x_max - c.x_min) * scale)
        const h = Math.max(1 / dpr, (c.y_max - c.y_min) * scale)
        context.fillRect(x, y, w, h)
        if (boundaries && w > 3) {
          context.strokeStyle = '#06102099'; context.lineWidth = .55
          context.strokeRect(x, y, w, h)
        }
      }
      if (ego && inView(ego.x, ego.y, view)) {
        const x = ox + ego.x * scale, y = oy - ego.y * scale
        const length = Math.max(12, 4.3 * scale), width = Math.max(7, 1.8 * scale)
        context.strokeStyle = EGO_COLOR; context.lineWidth = 1.5
        context.beginPath(); context.arc(x, y, Math.max(11, 2.9 * scale), 0, Math.PI * 2); context.stroke()
        context.fillStyle = EGO_COLOR; context.fillRect(x - length / 2, y - width / 2, length, width)
        context.strokeStyle = '#ffffff'; context.strokeRect(x - length / 2, y - width / 2, length, width)
        context.fillStyle = '#092633'; context.fillRect(x - length * .3, y - width * .34, length * .5, width * .68)
        context.fillStyle = '#ffffff'
        context.beginPath(); context.moveTo(x + length / 2 + 7, y)
        context.lineTo(x + length / 2 + 2, y - 4); context.lineTo(x + length / 2 + 2, y + 4); context.fill()
        context.font = 'bold 10px monospace'; context.textAlign = 'center'
        context.fillStyle = '#06242b'; context.fillRect(x - 17, y - width / 2 - 18, 34, 14)
        context.fillStyle = EGO_COLOR; context.fillText('EGO', x, y - width / 2 - 7)
        context.textAlign = 'left'
      }
      const rawScale = 50 / scale, magnitude = 10 ** Math.floor(Math.log10(rawScale))
      const distance = [1, 2, 5, 10].find(n => n * magnitude >= rawScale) * magnitude
      const bar = distance * scale
      context.fillStyle = '#06111ce8'; context.fillRect(8, rect.height - 38, bar + 20, 30)
      context.fillStyle = '#c5dce9'; context.font = '10px monospace'
      context.fillText(`${Number(distance.toPrecision(3))} m`, 14, rect.height - 23)
      context.fillRect(14, rect.height - 16, bar, 1)
      context.fillRect(14, rect.height - 19, 1, 6); context.fillRect(14 + bar, rect.height - 19, 1, 6)
      context.textAlign = 'right'; context.fillStyle = '#8ab4ce'
      context.fillText('Y +', rect.width - 14, 21); context.fillText('X +', rect.width - 14, 35)
      context.textAlign = 'left'
      if (!cells.length) { context.fillStyle = '#8ab4ce'; context.fillText('No labeled cells', 20, rect.height / 2) }
    }
    const observer = new ResizeObserver(draw)
    observer.observe(canvas); draw()
    return () => observer.disconnect()
  }, [cells, hiddenClasses, mode, boundaries, view, ego, zoom])
  return <canvas className="map-canvas" ref={canvasRef} aria-label={`${mode} top-down map`} />
}
