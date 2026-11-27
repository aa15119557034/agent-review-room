import { MathUtils, ShaderMaterial, Vector2, Vector3 } from 'three';

const CART_GRAIN = /* glsl */`
uniform vec3 uHarbourCartOrigin;
uniform vec2 uHarbourCartYaw;

vec3 wbCartLocal(vec3 world) {
  vec3 d = world - uHarbourCartOrigin;
  return vec3(-dot(d.xz, uHarbourCartYaw), d.y,
              dot(d.xz, vec2(-uHarbourCartYaw.y, uHarbourCartYaw.x)));
}

bool wbCartContains(vec3 p) {
  return all(greaterThan(p, vec3(-1.51, -0.035, -0.65))) &&
         all(lessThan(p, vec3(1.57, 1.41, 0.74)));
}

float wbCaskGrain(vec3 p, float normalY, float detail) {
  vec2 q = p.xz - vec2(-0.10, -0.08);
  if (p.y < 0.668 || p.y > 1.27 || dot(q, q) > 0.0686) return 1.0;
  // Staves meet at the joints of the original nine-sided barrel.
  float lid = smoothstep(1.218, 1.232, p.y) * smoothstep(0.55, 0.80, normalY);
  float phase = dot(q, q) > 0.000001 ? atan(q.x, -q.y) * 1.4323945 + 9.0 : 9.0;
  float lidPhase = (q.x + 0.018 + 0.085*q.y) / 0.073;
  float edge = abs(fract(mix(phase, lidPhase, lid) + 0.5) - 0.5);
  float joint = 1.0 - smoothstep(0.022, 0.058, edge);
  float warmStave = fract(floor(phase + 0.003) * 0.6180339);
  return 1.0 + detail * ((warmStave - 0.5) * 0.18 * (1.0 - lid) - 0.21 * joint);
}
`;

function insert(source, needle, addition) {
  if (!source.includes(needle)) throw new Error(`Larkhaven cart: missing town shader anchor ${needle}`);
  return source.replace(needle, addition);
}

/** Match the quay cart's baked pose. Pigment and bounce reuse the town light and shadows. */
export function applyHarbourCart(island) {
  if (island.timeOfDay !== 'evening') return;
  const town = island.town;
  const pose = town.buildings.find(({ id, town: townId, pos }) =>
    id === 'p_hand_cart' && townId === 'larkhaven' && pos[0] === -46 && pos[2] === 1121.2);
  if (!pose) throw new Error('Larkhaven cart: placement is missing');
  const origin = new Vector3(...pose.pos);
  const harbour = town.towns.find(({ id }) => id === 'larkhaven');
  const chunks = town.chunks.filter(({ box, mesh }) => mesh.parent === harbour?.group && box.containsPoint(origin));
  if (chunks.length !== 1) throw new Error('Larkhaven cart: expected one containing town chunk');
  const [{ mesh }] = chunks;
  const source = mesh.material;
  let shader = insert(source.fragmentShader, 'void main(){', `${CART_GRAIN}\nvoid main(){`);
  const light = 'float ao = vInfo.y;';
  shader = insert(shader, light, `vec3 wbCart = wbCartLocal(vWorld);
  bool wbCartWood = (mat == 3 || mat == 4) && wbCartContains(wbCart);
  bool wbCartHoop = mat == 13 && wbCartContains(wbCart);
  if (wbCartWood) {
    float grainDetail = 1.0 - smoothstep(8.0, 25.0, length(uCamPos - vWorld));
    if (mat == 4) alb *= wbCaskGrain(wbCart, N.y, grainDetail);
    // Warm worn timber and pale areas use the original grain and knots.
    alb += mat == 3 ? vec3(0.044, 0.024, 0.011) : vec3(0.031, 0.016, 0.006);
  }
  ${light}`);
  const ambient = 'amb *= mix(0.42, 1.0, ao);';
  shader = insert(shader, ambient, `${ambient}
  if (wbCartWood || wbCartHoop) {
    float face = mix(0.45, 1.0, smoothstep(-0.44, 0.65, dot(N, vec3(-0.65, 0.49, 0.58))));
    float shade = (1.0 - smoothstep(0.18, 0.66, sunVis)) * mix(0.45, 1.0, ao);
    vec3 woodBounce = wbCartWood ? vec3(0.28, 0.181, 0.092) : vec3(0.074, 0.054, 0.040);
    amb += woodBounce * (face * shade);
  }`);
  const yaw = MathUtils.degToRad(pose.yaw);
  mesh.material = new ShaderMaterial({
    vertexShader: source.vertexShader,
    fragmentShader: shader,
    uniforms: {
      ...source.uniforms,
      uHarbourCartOrigin: { value: origin },
      uHarbourCartYaw: { value: new Vector2(Math.cos(yaw), Math.sin(yaw)) },
    },
  });
}
