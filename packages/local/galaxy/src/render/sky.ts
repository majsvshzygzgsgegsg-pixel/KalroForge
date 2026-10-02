import { Color, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2 } from 'three'
import type { RGB } from '../core/color.ts'

/** Everything the sky needs for one frame. */
export interface SkyFrame {
  /** Drift clock, seconds. */
  time: number
  /** Orb colour for the bloom behind the centre. */
  bloomColor: RGB
  /** Bloom brightness. */
  bloom: number
  /** Extra nebula brightness while the AI talks or thinks, 0..1. */
  nebulaBoost: number
}

const SKY_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const SKY_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uBloomColor;
uniform float uBloom;
uniform float uNebulaBoost;

varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Five octaves, each rotated so the grid never lines up.
float fbm(vec2 p) {
  const mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * valueNoise(p);
    p = rot * p * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum;
}

// One star layer on a square grid in screen space. density: cells per unit of screen height.
float stars(vec2 p, float density, float chance, float radiusPx, float twinkleSpeed, float seed) {
  vec2 q = p * density;
  vec2 cell = floor(q);
  vec2 f = fract(q);
  float h = hash12(cell + seed);
  if (h > chance) return 0.0;
  vec2 center = vec2(hash12(cell + seed + 3.7), hash12(cell + seed + 9.1)) * 0.7 + 0.15;
  float cellPx = uResolution.y / density;
  float distPx = length(f - center) * cellPx;
  float core = smoothstep(radiusPx, 0.0, distPx);
  float twinkle = 0.55 + 0.45 * sin(uTime * twinkleSpeed * (0.6 + h * 2.4) + h * 40.0);
  return core * twinkle * (0.35 + 0.65 * hash12(cell + seed + 1.3));
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // Square in screen space: x is scaled by the aspect ratio.
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);
  float t = uTime;

  vec3 col = mix(vec3(0.0016, 0.0026, 0.0068), vec3(0.0003, 0.0005, 0.0014), smoothstep(0.1, 1.0, r));

  // Squared soft thresholds turn the noise into wisps instead of fog.
  float boost = 1.0 + uNebulaBoost * 0.9;
  float n1 = smoothstep(0.55, 0.9, fbm(p * 1.7 + vec2(t * 0.0040, t * 0.0026)));
  float n2 = smoothstep(0.57, 0.92, fbm(p * 2.3 + vec2(-t * 0.0031, t * 0.0037) + 41.0));
  float n3 = smoothstep(0.54, 0.9, fbm(p * 1.2 + vec2(t * 0.0022, -t * 0.0030) + 83.0));
  col += vec3(0.0080, 0.0400, 0.0290) * n1 * n1 * boost;
  col += vec3(0.0320, 0.0095, 0.0480) * n2 * n2 * boost;
  col += vec3(0.0065, 0.0160, 0.0560) * n3 * n3 * boost;

  float bloom = 0.5 * exp(-r * r * 14.0) + 0.3 * exp(-r * r * 4.0) + 0.12 * exp(-r * r * 1.1);
  col += uBloomColor * bloom * uBloom * 0.045;
  col += vec3(0.55, 0.85, 0.95) * exp(-r * r * 220.0) * uBloom * 0.012;

  float fine = stars(p, 150.0, 0.16, 1.2, 1.3, 0.0);
  float soft = stars(p, 26.0, 0.2, 2.8, 0.7, 51.0);
  col += vec3(0.75, 0.85, 1.0) * (fine * 0.7 + soft * 0.9);

  col *= 1.0 - 0.6 * smoothstep(0.35, 1.15, r);

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`

/** The full-screen sky: deep space, nebula wisps, an orb-coloured bloom, and twinkling stars. */
export class SkyLayer {
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly material: ShaderMaterial
  private readonly uniforms = {
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uBloomColor: { value: new Color() },
    uBloom: { value: 0 },
    uNebulaBoost: { value: 0 },
  }

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    })
    const mesh = new Mesh(this.geometry, this.material)
    mesh.frustumCulled = false
    this.scene.add(mesh)
  }

  /**
   * Tell the shader the drawing-buffer size, so stars stay square.
   * @param width - pixels.
   * @param height - pixels.
   */
  setSize(width: number, height: number): void {
    this.uniforms.uResolution.value.set(width, height)
  }

  /**
   * Apply one frame of pre-computed values.
   * @param frame - this frame's values.
   */
  update(frame: SkyFrame): void {
    this.uniforms.uTime.value = frame.time
    this.uniforms.uBloomColor.value.setRGB(frame.bloomColor[0], frame.bloomColor[1], frame.bloomColor[2])
    this.uniforms.uBloom.value = frame.bloom
    this.uniforms.uNebulaBoost.value = frame.nebulaBoost
  }

  /** Free the geometry and material. */
  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.scene.clear()
  }
}
