#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;   // glyph-space coords, smoothed
uniform float uIntro;  // 1 at load -> 0 when settled
uniform vec3 uPulse;   // xy: glyph-space origin of last tap, z: seconds since
uniform float uMotion; // 0 = reduced motion

// ---- palette (see README design notes) ----
const vec3 GROUND = vec3(0.075, 0.082, 0.110); // #13151c deep slate
const vec3 LIGHT  = vec3(0.914, 0.918, 0.945); // #e9eaf1 pale glass
const vec3 RULE   = vec3(0.412, 0.431, 0.510); // #696e82 dim rule

// ---- noise ----
float hash(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}
float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(hash(i), hash(i + vec2(1, 0)), u.x),
		mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
	float a = 0.5, s = 0.0;
	mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
	for (int i = 0; i < 4; i++) {
		s += a * vnoise(p);
		p = m * p;
		a *= 0.5;
	}
	return s;
}

// ---- sdf primitives ----
float sdSegment(vec2 p, vec2 a, vec2 b) {
	vec2 pa = p - a, ba = b - a;
	float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
	return length(pa - ba * h);
}
// Inigo Quilez: arc symmetric about +y, half-aperture encoded in sc = (sin, cos)
float sdArc(vec2 p, vec2 sc, float ra, float rb) {
	p.x = abs(p.x);
	return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb;
}
float smin(float a, float b, float k) {
	float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
	return mix(b, a, h) - k * h * (1.0 - h);
}

const float W = 0.072; // stroke half-width

// The Q. About 1 unit tall, centred on the origin.
float glyph(vec2 p) {
	float R = 0.36;
	vec2 c = vec2(0.0, 0.05);
	float bowl = abs(length(p - c) - R) - W;
	float tail = sdSegment(p, c + vec2(0.68, -0.73) * 0.30, c + vec2(0.68, -0.73) * 0.64) - W * 0.92;
	return smin(bowl, tail, 0.05);
}

// Warped field: the glyph never quite holds still.
float field(vec2 p) {
	float t = uTime * 0.18 * uMotion;
	float amp = 0.022 + uIntro * 0.55;
	vec2 n = vec2(fbm(p * 2.2 + vec2(t, -t * 0.7)), fbm(p * 2.2 + vec2(-t * 0.6, t) + 9.1)) - 0.5;
	p += n * amp;
	// tap ripple
	if (uPulse.z < 6.0) {
		vec2 d = p - uPulse.xy;
		float r = length(d);
		float ring = sin(r * 34.0 - uPulse.z * 9.0) * exp(-uPulse.z * 1.6) * exp(-r * 2.2);
		p += normalize(d + 1e-4) * ring * 0.045;
	}
	// pointer nudges the field like a magnet held near it
	vec2 m = p - uMouse;
	float mr = length(m);
	p += normalize(m + 1e-4) * 0.018 * exp(-mr * mr * 6.0);
	return glyph(p);
}

// Ruled ground: fine diagonal lines, very slightly wandering.
float rules(vec2 p) {
	float wobble = (fbm(p * 1.3 + 3.7) - 0.5) * 0.02;
	float k = dot(p, normalize(vec2(0.42, 1.0))) + wobble;
	float f = k * 64.0;
	float w = fwidth(f);
	float line = abs(fract(f) - 0.5) * 2.0; // 0 at line centre
	return 1.0 - smoothstep(0.22, 0.22 + w * 1.4, line);
}

vec3 spectrum(float t) {
	return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0, 1.0, 1.0) * t + vec3(0.00, 0.33, 0.67)));
}

void main() {
	vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
	float scale = uRes.x < uRes.y ? 1.35 * (uRes.y / uRes.x) * 0.75 : 1.55;
	vec2 p = uv * scale;

	float d = field(p);
	float e = 0.0025;
	vec2 g = vec2(field(p + vec2(e, 0.0)) - field(p - vec2(e, 0.0)),
	              field(p + vec2(0.0, e)) - field(p - vec2(0.0, e))) / (2.0 * e);
	vec2 n = g / max(length(g), 1e-4);

	float inside = 1.0 - smoothstep(-0.004, 0.004, d);

	// glass rod: refraction strongest at the edge, none down the spine
	float depth = clamp(-d / W, 0.0, 1.0);
	float lens = sqrt(max(0.0, 1.0 - depth)) * (1.0 - depth) * inside;
	vec2 bend = -n * lens * 0.05;

	// chromatic spread inside the glass
	float lr = rules(p + bend * 1.06);
	float lg = rules(p + bend);
	float lb = rules(p + bend * 0.94);
	vec3 ruled = vec3(lr, lg, lb);

	float outsideRules = rules(p);
	vec3 col = GROUND;

	// outside: quiet rules
	col = mix(col, RULE, outsideRules * 0.30 * (1.0 - inside));
	// inside: rules refracted and lit, glass body faintly milky
	col = mix(col, LIGHT, 0.06 * inside);
	col = mix(col, LIGHT, ruled * 0.78 * inside);

	// thin-film rim, hue drifts with pointer + time
	float rim = 1.0 - smoothstep(0.0, 0.02, abs(d + 0.004));
	float film = d * 42.0 + uTime * 0.05 * uMotion + uMouse.x * 0.35 + uMouse.y * 0.2;
	vec3 iri = mix(spectrum(film), LIGHT, 0.15);
	col = mix(col, iri, rim * 0.5);

	// soft glow just outside the glass
	float shade = (1.0 - smoothstep(0.0, 0.06, d)) * (1.0 - inside);
	col = mix(col, iri, shade * 0.10);

	// paper grain, vignette
	float grain = hash(gl_FragCoord.xy + fract(uTime) * 7.0) - 0.5;
	col += grain * 0.022;
	col *= 1.0 - 0.30 * dot(uv, uv);

	fragColor = vec4(col, 1.0);
}
