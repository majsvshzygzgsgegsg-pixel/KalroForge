import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Object3D,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  ShaderMaterial,
} from 'three'
import type { RGB } from '../core/color.ts'
import { MAX_DISPLACEMENT } from '../core/orb-motion.ts'
import { SIMPLEX_3D } from './glsl.ts'

/** Everything the orb needs for one frame. All values are pre-computed by the engine. */
export interface OrbFrame {
  colorA: RGB
  colorB: RGB
  opacity: number
  fresnelPower: number
  glow: number
  ringOpacity: number
  noiseTime: number
  activity: number
  highMix: number
  bass: number
  pushPhase: number
  scale: number
  rotationY: number
  rotationX: number
  ringPhase: number
}

const ORB_VERTEX = /* glsl */ `
uniform float uNoiseTime;
uniform float uActivity;
uniform float uHighMix;
uniform float uBass;
uniform float uPushPhase;

varying vec3 vNormalV;
varying vec3 vViewDir;
varying float vDisp;

${SIMPLEX_3D}

void main() {
  vec3 n = normalize(position);
  float t = uNoiseTime;
  float noise =
      0.5 * snoise(n * 1.1 + vec3(t * 0.6, t * 0.4, -t * 0.5))
    + 0.3 * snoise(n * 2.3 + vec3(-t * 0.9, t * 0.7, t * 0.3) + 11.7)
    + 0.2 * uHighMix * snoise(n * 4.8 + vec3(t * 1.6, -t * 1.2, t * 1.4) + 37.1);
  float push = uBass * 0.08 * sin(n.y * 5.0 - uPushPhase);
  float d = clamp(noise * uActivity + push, -${MAX_DISPLACEMENT.toFixed(2)}, ${MAX_DISPLACEMENT.toFixed(2)});

  vec4 mv = modelViewMatrix * vec4(position + n * d, 1.0);
  vNormalV = normalize(normalMatrix * n);
  vViewDir = normalize(-mv.xyz);
  vDisp = d;
  gl_Position = projectionMatrix * mv;
}
`

const ORB_FRAGMENT = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
uniform float uFresnelPower;

varying vec3 vNormalV;
varying vec3 vViewDir;
varying float vDisp;

void main() {
  vec3 N = normalize(vNormalV);
  vec3 V = normalize(vViewDir);
  float facing = dot(N, V);
  float fresnel = pow(1.0 - abs(facing), uFresnelPower);
  float back = facing < 0.0 ? 0.45 : 1.0;

  vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 0.18, vDisp) * 0.65);
  col *= 0.7 + 0.9 * fresnel;
  float alpha = uOpacity * (0.06 + 0.94 * fresnel) * back;

  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`

const GLOW_VERTEX = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewDir;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normalize(position));
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

// Back faces of the r=1.3 shell: |N.V| is 0 at the shell's rim and ~0.64 at the orb's silhouette.
// The glow peaks at the silhouette, fades outward to nothing, and stays dim behind the orb
// so it reads as a halo rather than a filled disc.
const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uGlow;

varying vec3 vNormalV;
varying vec3 vViewDir;

void main() {
  float d = abs(dot(normalize(vNormalV), normalize(vViewDir)));
  float outer = pow(smoothstep(0.0, 0.66, d), 2.2);
  float inner = 1.0 - 0.82 * smoothstep(0.62, 0.9, d);
  float halo = outer * inner * uGlow;
  gl_FragColor = vec4(uColor * halo, halo);
  #include <colorspace_fragment>
}
`

const RING_SPECS = [
  { radius: 1.55, tiltX: 1.15, tiltY: 0.25, speed: 0.22, weight: 1 },
  { radius: 1.65, tiltX: 1.4, tiltY: -0.55, speed: -0.16, weight: 0.75 },
  { radius: 1.75, tiltX: 0.85, tiltY: 0.9, speed: 0.3, weight: 0.55 },
] as const

interface Ring {
  readonly mesh: Mesh<RingGeometry, MeshBasicMaterial>
  readonly speed: number
  readonly weight: number
}

/** The wireframe orb, its glow shell, and three orbital rings, with their own camera. */
export class OrbLayer {
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(45, 1, 0.1, 100)

  private readonly body = new Group()
  private readonly ringGroup = new Group()
  private orbGeometry: IcosahedronGeometry
  private readonly orbMesh: Mesh
  private readonly glowGeometry = new IcosahedronGeometry(1.3, 6)
  private readonly orbMaterial: ShaderMaterial
  private readonly glowMaterial: ShaderMaterial
  private readonly rings: Ring[] = []
  private readonly tmpColor = new Color()
  private readonly orbUniforms = {
    uNoiseTime: { value: 0 },
    uActivity: { value: 0 },
    uHighMix: { value: 0 },
    uBass: { value: 0 },
    uPushPhase: { value: 0 },
    uColorA: { value: new Color() },
    uColorB: { value: new Color() },
    uOpacity: { value: 0.5 },
    uFresnelPower: { value: 2 },
  }
  private readonly glowUniforms = {
    uColor: { value: new Color() },
    uGlow: { value: 0 },
  }

  /**
   * @param detail - icosahedron subdivision level of the wireframe.
   */
  constructor(detail: number) {
    this.camera.position.set(0, 0, 4.2)

    this.orbGeometry = new IcosahedronGeometry(1, detail)
    this.orbMaterial = new ShaderMaterial({
      vertexShader: ORB_VERTEX,
      fragmentShader: ORB_FRAGMENT,
      uniforms: this.orbUniforms,
      wireframe: true,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    })

    this.glowMaterial = new ShaderMaterial({
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: this.glowUniforms,
      side: BackSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })

    const glow = new Mesh(this.glowGeometry, this.glowMaterial)
    glow.renderOrder = 0
    this.orbMesh = new Mesh(this.orbGeometry, this.orbMaterial)
    this.orbMesh.renderOrder = 1
    this.body.add(glow, this.orbMesh)

    for (const spec of RING_SPECS) {
      const pivot = new Object3D()
      pivot.rotation.set(spec.tiltX, spec.tiltY, 0)
      const mesh = new Mesh(
        new RingGeometry(spec.radius - 0.0035, spec.radius + 0.0035, 256, 1),
        new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending, opacity: 0 }),
      )
      mesh.renderOrder = 2
      mesh.visible = false
      pivot.add(mesh)
      this.ringGroup.add(pivot)
      this.rings.push({ mesh, speed: spec.speed, weight: spec.weight })
    }

    this.scene.add(this.body, this.ringGroup)
  }

  /**
   * Rebuild the wireframe at another subdivision level (performance mode).
   * @param detail - icosahedron subdivision level.
   */
  setDetail(detail: number): void {
    const next = new IcosahedronGeometry(1, detail)
    this.orbMesh.geometry = next
    this.orbGeometry.dispose()
    this.orbGeometry = next
  }

  /**
   * Match the camera to the canvas.
   * @param aspect - width / height.
   */
  setAspect(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  /**
   * Apply one frame of pre-computed values.
   * @param frame - this frame's values.
   */
  update(frame: OrbFrame): void {
    const u = this.orbUniforms
    u.uNoiseTime.value = frame.noiseTime
    u.uActivity.value = frame.activity
    u.uHighMix.value = frame.highMix
    u.uBass.value = frame.bass
    u.uPushPhase.value = frame.pushPhase
    u.uColorA.value.setRGB(frame.colorA[0], frame.colorA[1], frame.colorA[2])
    u.uColorB.value.setRGB(frame.colorB[0], frame.colorB[1], frame.colorB[2])
    u.uOpacity.value = frame.opacity
    u.uFresnelPower.value = frame.fresnelPower

    this.glowUniforms.uColor.value.setRGB(frame.colorA[0], frame.colorA[1], frame.colorA[2])
    this.glowUniforms.uGlow.value = frame.glow

    this.body.scale.setScalar(frame.scale)
    this.body.rotation.set(frame.rotationX, frame.rotationY, 0)

    this.ringGroup.scale.setScalar(frame.scale)
    this.tmpColor.setRGB(
      (frame.colorA[0] + frame.colorB[0]) * 0.5,
      (frame.colorA[1] + frame.colorB[1]) * 0.5,
      (frame.colorA[2] + frame.colorB[2]) * 0.5,
    )
    for (const ring of this.rings) {
      const opacity = frame.ringOpacity * ring.weight
      ring.mesh.visible = opacity > 0.002
      ring.mesh.material.opacity = opacity
      ring.mesh.material.color.copy(this.tmpColor)
      ring.mesh.rotation.z = frame.ringPhase * ring.speed
    }
  }

  /** Free every geometry and material. */
  dispose(): void {
    this.orbGeometry.dispose()
    this.glowGeometry.dispose()
    this.orbMaterial.dispose()
    this.glowMaterial.dispose()
    for (const ring of this.rings) {
      ring.mesh.geometry.dispose()
      ring.mesh.material.dispose()
    }
    this.scene.clear()
  }
}
