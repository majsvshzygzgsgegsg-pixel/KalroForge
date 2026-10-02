import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
} from 'three'
import type { NetworkLayout } from '../core/network-layout.ts'

/** Everything the network needs for one frame. */
export interface NetworkFrame {
  /** Accumulated rotation, radians. */
  rotation: number
  /** Animation clock for tilt and camera drift, seconds. */
  time: number
  lineOpacity: number
  nodeBrightness: number
  nodeSize: number
  swell: number
  push: number
  shake: number
}

const NODE_VERTEX = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uSizeScale;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uSizeScale * uPixelRatio * (480.0 / max(-mv.z, 1.0));
  gl_Position = projectionMatrix * mv;
}
`

// Bright core, half-bright at 30% of the radius, nothing at the edge. No texture.
const NODE_FRAGMENT = /* glsl */ `
uniform float uBrightness;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d >= 1.0) discard;
  float falloff = d < 0.3 ? mix(1.0, 0.5, d / 0.3) : 0.5 * pow(1.0 - (d - 0.3) / 0.7, 2.0);
  vec3 col = vColor * falloff * uBrightness;
  gl_FragColor = vec4(col, falloff);
  #include <colorspace_fragment>
}
`

const DUST_VERTEX = /* glsl */ `
uniform float uPixelRatio;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = 1.4 * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}
`

const DUST_FRAGMENT = /* glsl */ `
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d >= 1.0) discard;
  float a = (1.0 - d) * 0.22;
  gl_FragColor = vec4(vec3(0.42, 0.5, 0.64) * a, a);
  #include <colorspace_fragment>
}
`

const CAMERA_DISTANCE = 42

/** The slowly turning network of glowing star clusters joined by faint lines, with its own camera. */
export class NetworkLayer {
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(60, 1, 0.1, 400)

  private readonly group = new Group()
  private nodeGeometry = new BufferGeometry()
  private linkGeometry = new BufferGeometry()
  private dustGeometry = new BufferGeometry()
  private readonly nodeUniforms = {
    uSizeScale: { value: 1 },
    uPixelRatio: { value: 1 },
    uBrightness: { value: 1 },
  }
  private readonly dustUniforms = { uPixelRatio: { value: 1 } }
  private readonly nodeMaterial: ShaderMaterial
  private readonly linkMaterial: LineBasicMaterial
  private readonly dustMaterial: ShaderMaterial
  private readonly nodes: Points
  private readonly links: LineSegments
  private readonly dust: Points

  /**
   * @param layout - seeded network layout.
   */
  constructor(layout: NetworkLayout) {
    this.camera.position.set(0, 0, CAMERA_DISTANCE)
    this.nodeMaterial = new ShaderMaterial({
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      uniforms: this.nodeUniforms,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    this.linkMaterial = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      opacity: 0.12,
    })
    this.dustMaterial = new ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      uniforms: this.dustUniforms,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    this.nodes = new Points(this.nodeGeometry, this.nodeMaterial)
    this.links = new LineSegments(this.linkGeometry, this.linkMaterial)
    this.dust = new Points(this.dustGeometry, this.dustMaterial)
    this.group.add(this.links, this.nodes)
    this.scene.add(this.group, this.dust)
    this.setLayout(layout)
  }

  /**
   * Replace the uploaded layout (performance mode swaps in a thinner one).
   * @param layout - seeded network layout.
   */
  setLayout(layout: NetworkLayout): void {
    const positions: number[] = []
    const colors: number[] = []
    const sizes: number[] = []
    for (const node of layout.nodes) {
      positions.push(...node.position)
      colors.push(...node.color)
      sizes.push(node.size)
    }
    const nodeGeometry = new BufferGeometry()
    nodeGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    nodeGeometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3))
    nodeGeometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1))

    const linkPositions: number[] = []
    const linkColors: number[] = []
    for (const [a, b] of layout.links) {
      const na = layout.nodes[a]
      const nb = layout.nodes[b]
      if (na === undefined || nb === undefined) continue
      linkPositions.push(...na.position, ...nb.position)
      linkColors.push(...na.color, ...nb.color)
    }
    const linkGeometry = new BufferGeometry()
    linkGeometry.setAttribute('position', new Float32BufferAttribute(linkPositions, 3))
    linkGeometry.setAttribute('color', new Float32BufferAttribute(linkColors, 3))

    const dustGeometry = new BufferGeometry()
    dustGeometry.setAttribute('position', new Float32BufferAttribute(layout.dust.flat(), 3))

    this.nodes.geometry = nodeGeometry
    this.links.geometry = linkGeometry
    this.dust.geometry = dustGeometry
    this.nodeGeometry.dispose()
    this.linkGeometry.dispose()
    this.dustGeometry.dispose()
    this.nodeGeometry = nodeGeometry
    this.linkGeometry = linkGeometry
    this.dustGeometry = dustGeometry
  }

  /**
   * Match the camera and sprite sizes to the canvas.
   * @param aspect - width / height.
   * @param pixelRatio - renderer pixel ratio.
   */
  setViewport(aspect: number, pixelRatio: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
    this.nodeUniforms.uPixelRatio.value = pixelRatio
    this.dustUniforms.uPixelRatio.value = pixelRatio
  }

  /**
   * Apply one frame of pre-computed values.
   * @param frame - this frame's values.
   */
  update(frame: NetworkFrame): void {
    const t = frame.time
    this.group.rotation.set(Math.sin(t * 0.045) * 0.14, frame.rotation, Math.sin(t * 0.031) * 0.05)
    this.group.scale.setScalar(frame.swell)
    this.dust.rotation.y = frame.rotation * 0.3
    const shakeX = Math.sin(t * 23.0) * Math.sin(t * 7.3) * frame.shake
    const shakeY = Math.sin(t * 19.0 + 1.3) * Math.sin(t * 5.1) * frame.shake
    this.camera.position.set(
      Math.sin(t * 0.013) * 2 + shakeX,
      Math.cos(t * 0.017) * 1.2 + shakeY,
      CAMERA_DISTANCE - frame.push + Math.sin(t * 0.009) * 1.5,
    )
    this.camera.lookAt(0, 0, 0)
    this.linkMaterial.opacity = frame.lineOpacity
    this.nodeUniforms.uBrightness.value = frame.nodeBrightness
    this.nodeUniforms.uSizeScale.value = frame.nodeSize
  }

  /** Free every geometry and material. */
  dispose(): void {
    this.nodeGeometry.dispose()
    this.linkGeometry.dispose()
    this.dustGeometry.dispose()
    this.nodeMaterial.dispose()
    this.linkMaterial.dispose()
    this.dustMaterial.dispose()
    this.scene.clear()
  }
}
