import type * as THREE from 'three'

export type BlueState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'executing' | 'success' | 'clarify' | 'sleep'

export interface BlueModelInstance {
  group: THREE.Group
  updateExpression(state: BlueState, time: number, level: number): void
  setGaze(x: number, y: number): void
  dispose(): void
  dimensions: { width: number; height: number; depth: number }
}

export const BlueModel: {
  create(three: typeof THREE): BlueModelInstance
  version: string
}
