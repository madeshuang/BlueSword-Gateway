import { lazy, Suspense, useState } from 'react'
import type { Phase } from '../types'
import { BluePet } from './BluePet'

// three.js 体积较大，单独拆包按需加载，不拖慢首屏
const BluePet3D = lazy(() => import('../pet3d/BluePet3D'))

/** 优先 3D 布鲁；浏览器不支持 WebGL 时退回 2D 版 */
export function Pet(props: { phase: Phase | 'sleep'; onActivate: () => void }) {
  const [webgl, setWebgl] = useState(() => {
    try {
      return !!document.createElement('canvas').getContext('webgl2')
    } catch {
      return false
    }
  })
  if (!webgl) return <BluePet {...props} />
  return (
    <Suspense fallback={<div className="pet3d-placeholder" />}>
      <BluePet3D {...props} onFail={() => setWebgl(false)} />
    </Suspense>
  )
}
