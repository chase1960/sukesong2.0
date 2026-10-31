/* React Bits 背景 — vanilla 移植（OGL / Canvas2D / WebGL2）
   来源：https://reactbits.dev/backgrounds · DavidHDev/react-bits (MIT) */
import { Renderer, Program, Mesh, Triangle, Color } from './vendor/ogl/index.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
    : [1, 1, 1];
}

function linkOk(gl, program) {
  if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
    console.error('[react-bits-bg] shader 链接失败:', gl.getProgramInfoLog(program.program));
    return false;
  }
  return true;
}

/* ── Grainient（纸纹渐变 · WebGL2） ── */
const GRAINIENT_VERT = `#version 300 es
in vec2 position;
void main(){gl_Position=vec4(position,0.0,1.0);}
`;
const GRAINIENT_FRAG = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uTimeSpeed;
uniform float uColorBalance;
uniform float uWarpStrength;
uniform float uWarpFrequency;
uniform float uWarpSpeed;
uniform float uWarpAmplitude;
uniform float uBlendAngle;
uniform float uBlendSoftness;
uniform float uRotationAmount;
uniform float uNoiseScale;
uniform float uGrainAmount;
uniform float uGrainScale;
uniform float uGrainAnimated;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform vec2 uCenterOffset;
uniform float uZoom;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec2 uMouse;
uniform float uMouseInfluence;
uniform float uMouseVel;
uniform vec2 uRippleOrigin;
uniform float uRippleAge;
out vec4 fragColor;
#define S(a,b,t) smoothstep(a,b,t)
#define PI 3.14159265
mat2 Rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
vec2 hash(vec2 p){p=vec2(dot(p,vec2(2127.1,81.17)),dot(p,vec2(1269.5,283.37)));return fract(sin(p)*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);float n=mix(mix(dot(-1.0+2.0*hash(i+vec2(0.0,0.0)),f-vec2(0.0,0.0)),dot(-1.0+2.0*hash(i+vec2(1.0,0.0)),f-vec2(1.0,0.0)),u.x),mix(dot(-1.0+2.0*hash(i+vec2(0.0,1.0)),f-vec2(0.0,1.0)),dot(-1.0+2.0*hash(i+vec2(1.0,1.0)),f-vec2(1.0,1.0)),u.x),u.y);return 0.5+0.5*n;}
void mainImage(out vec4 o, vec2 C){
 float t=iTime*uTimeSpeed;
 vec2 uv=C/iResolution.xy;
 float ratio=iResolution.x/iResolution.y;
 vec2 aspect=vec2(ratio,1.0);

 // 宽软影响力：像布面被手指轻轻带起，而不是局部硬凸起
 vec2 mouseDelta=(uv-uMouse)*aspect;
 float mouseDist=length(mouseDelta);
 float fall=uMouseInfluence*exp(-mouseDist*mouseDist*2.1);
 float fallWide=uMouseInfluence*exp(-mouseDist*mouseDist*0.85);
 vec2 dir=normalize(mouseDelta+1e-5);
 vec2 tangent=vec2(-dir.y,dir.x);

 // 点击：柔和扩散墨晕（单峰高斯环），不要机械同心正弦波
 vec2 rippleDelta=(uv-uRippleOrigin)*aspect;
 float rippleDist=length(rippleDelta);
 float ra=uRippleAge;
 float ink=0.0;
 if(ra<3.2){
  float ringR=ra*0.28;
  ink=exp(-pow(rippleDist-ringR,2.0)*14.0)*exp(-ra*0.95)*(1.0-smoothstep(0.0,0.12,ra)*0.15);
 }

 vec2 tuv=uv-0.5+uCenterOffset;
 // 速度沿切线「拖」纸纹，径向只轻轻推开 —— 流体感
 tuv+=tangent*fall*uMouseVel*0.11;
 tuv+=dir*fall*0.028;
 tuv-=dir*ink*0.03;
 tuv/=max(uZoom,0.001);

 float degree=noise(vec2(t*0.1,tuv.x*tuv.y)*uNoiseScale);
 tuv.y*=1.0/ratio;
 tuv*=Rot(radians((degree-0.5)*uRotationAmount+180.0));
 tuv.y*=ratio;
 float frequency=uWarpFrequency;
 float ws=max(uWarpStrength,0.001);
 float amplitude=uWarpAmplitude/ws;
 float warpTime=t*uWarpSpeed;
 // 指针附近略加快流动相位，避免另加高频 sin 抖动
 warpTime+=fallWide*uMouseVel*1.8+ink*0.8;
 tuv.x+=sin(tuv.y*frequency+warpTime)/amplitude;
 tuv.y+=sin(tuv.x*(frequency*1.5)+warpTime)/(amplitude*0.5);

 vec3 colLav=uColor1;
 vec3 colOrg=uColor2;
 vec3 colDark=uColor3;
 float b=uColorBalance;
 float s=max(uBlendSoftness,0.0);
 mat2 blendRot=Rot(radians(uBlendAngle));
 float blendX=(tuv*blendRot).x;
 float edge0=-0.3-b-s;
 float edge1=0.2-b+s;
 float v0=0.5-b+s;
 float v1=-0.3-b-s;
 vec3 layer1=mix(colDark,colOrg,S(edge0,edge1,blendX));
 vec3 layer2=mix(colOrg,colLav,S(edge0,edge1,blendX));
 vec3 col=mix(layer1,layer2,S(v0,v1,tuv.y));
 // 色响应压得很轻，避免「绿手电筒」跟着鼠标
 col=mix(col,mix(col,colOrg,0.22),fallWide*0.18+ink*0.12);
 vec2 grainUv=uv*max(uGrainScale,0.001);
 if(uGrainAnimated>0.5){grainUv+=vec2(iTime*0.05);}
 float grain=fract(sin(dot(grainUv,vec2(12.9898,78.233)))*43758.5453);
 col+=(grain-0.5)*uGrainAmount;
 col=(col-0.5)*uContrast+0.5;
 float luma=dot(col,vec3(0.2126,0.7152,0.0722));
 col=mix(vec3(luma),col,uSaturation);
 col=pow(max(col,0.0),vec3(1.0/max(uGamma,0.001)));
 o=vec4(clamp(col,0.0,1.0),1.0);
}
void main(){vec4 o=vec4(0.0);mainImage(o,gl_FragCoord.xy);fragColor=o;}
`;

export function mountGrainient(container, opts = {}) {
  const interactive = opts.interactive !== false && !reduced;
  const cfg = {
    timeSpeed: reduced ? 0 : 0.18,
    colorBalance: 0.05,
    warpStrength: 0.85,
    warpFrequency: 4.5,
    warpSpeed: 1.2,
    warpAmplitude: 55,
    blendSoftness: 0.12,
    rotationAmount: 380,
    noiseScale: 1.8,
    grainAmount: 0.09,
    grainScale: 2.2,
    contrast: 1.15,
    gamma: 1.05,
    saturation: 0.85,
    zoom: 0.92,
    color1: '#E8EAEB',
    color2: '#10B981',
    color3: '#EFF0F1',
    ...opts,
  };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  container.appendChild(canvas);

  let renderer;
  try {
    renderer = new Renderer({ webgl: 2, alpha: true, antialias: false, dpr: Math.min(devicePixelRatio || 1, 1.5), canvas });
  } catch {
    canvas.remove();
    return () => {};
  }
  const gl = renderer.gl;
  const geometry = new Triangle(gl);
  const program = new Program(gl, {
    vertex: GRAINIENT_VERT,
    fragment: GRAINIENT_FRAG,
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: new Float32Array([1, 1]) },
      uTimeSpeed: { value: cfg.timeSpeed },
      uColorBalance: { value: cfg.colorBalance },
      uWarpStrength: { value: cfg.warpStrength },
      uWarpFrequency: { value: cfg.warpFrequency },
      uWarpSpeed: { value: cfg.warpSpeed },
      uWarpAmplitude: { value: cfg.warpAmplitude },
      uBlendAngle: { value: 0 },
      uBlendSoftness: { value: cfg.blendSoftness },
      uRotationAmount: { value: cfg.rotationAmount },
      uNoiseScale: { value: cfg.noiseScale },
      uGrainAmount: { value: cfg.grainAmount },
      uGrainScale: { value: cfg.grainScale },
      uGrainAnimated: { value: 0 },
      uContrast: { value: cfg.contrast },
      uGamma: { value: cfg.gamma },
      uSaturation: { value: cfg.saturation },
      uCenterOffset: { value: new Float32Array([0, 0]) },
      uZoom: { value: cfg.zoom },
      uColor1: { value: new Float32Array(hexToRgb(cfg.color1)) },
      uColor2: { value: new Float32Array(hexToRgb(cfg.color2)) },
      uColor3: { value: new Float32Array(hexToRgb(cfg.color3)) },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
      uMouseInfluence: { value: 0 },
      uMouseVel: { value: 0 },
      uRippleOrigin: { value: new Float32Array([0.5, 0.5]) },
      uRippleAge: { value: 99 },
    },
  });
  if (!linkOk(gl, program)) { canvas.remove(); return () => {}; }
  const mesh = new Mesh(gl, { geometry, program });

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    const res = program.uniforms.iResolution.value;
    res[0] = gl.drawingBufferWidth;
    res[1] = gl.drawingBufferHeight;
  };
  window.addEventListener('resize', resize);
  resize();

  const targetMouse = [0.5, 0.5];
  const softMouse = [0.5, 0.5];
  const mouseVel = [0, 0];
  let targetInfluence = 0;
  let softInfluence = 0;
  let softSpeed = 0;
  let lastTarget = [0.5, 0.5];
  let lastFrame = performance.now();
  let rippleAt = -99;
  let blendAngle = 0;

  const pointerFromEvent = (e) => {
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    const inside = x >= -0.02 && x <= 1.02 && y >= -0.02 && y <= 1.02;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), inside };
  };

  const onMove = (e) => {
    if (!interactive) return;
    const p = pointerFromEvent(e);
    if (!p) return;
    targetMouse[0] = p.x;
    targetMouse[1] = p.y;
    targetInfluence = p.inside ? 1 : 0;
  };
  const onLeave = () => { targetInfluence = 0; };
  const onClick = (e) => {
    if (!interactive) return;
    const p = pointerFromEvent(e);
    if (!p || !p.inside) return;
    program.uniforms.uRippleOrigin.value[0] = softMouse[0];
    program.uniforms.uRippleOrigin.value[1] = softMouse[1];
    rippleAt = performance.now();
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerleave', onLeave);
  window.addEventListener('pointerdown', onClick);

  const t0 = performance.now();
  let frame = 0;
  let alive = true;
  const loop = (t) => {
    if (!alive) return;
    const now = (t - t0) * 0.001;
    const dt = Math.min(0.033, Math.max(0.001, (t - lastFrame) * 0.001));
    lastFrame = t;
    program.uniforms.iTime.value = now;

    if (interactive) {
      // 弹簧跟随：略欠阻尼，停手时有一点余韵，不会像线性 lerp 那样「咬死」
      const stiff = 28;
      const damp = 9.5;
      for (let i = 0; i < 2; i++) {
        const force = (targetMouse[i] - softMouse[i]) * stiff - mouseVel[i] * damp;
        mouseVel[i] += force * dt;
        softMouse[i] += mouseVel[i] * dt;
      }

      const rawSpeed = Math.hypot(targetMouse[0] - lastTarget[0], targetMouse[1] - lastTarget[1]) / dt;
      lastTarget[0] = targetMouse[0];
      lastTarget[1] = targetMouse[1];
      const speedNorm = Math.min(1, rawSpeed * 0.35);
      // 速度也用慢半拍的平滑，避免抖动
      softSpeed += (speedNorm - softSpeed) * (1 - Math.exp(-dt * 6));
      softInfluence += (targetInfluence - softInfluence) * (1 - Math.exp(-dt * 4.5));

      // 视差再慢一档，纸面像在水里漂
      const ox = (0.5 - softMouse[0]) * 0.045 * softInfluence;
      const oy = (0.5 - softMouse[1]) * 0.032 * softInfluence;
      const curOx = program.uniforms.uCenterOffset.value[0];
      const curOy = program.uniforms.uCenterOffset.value[1];
      program.uniforms.uCenterOffset.value[0] = curOx + (ox - curOx) * (1 - Math.exp(-dt * 3.2));
      program.uniforms.uCenterOffset.value[1] = curOy + (oy - curOy) * (1 - Math.exp(-dt * 3.2));

      // 缓慢扭转色带角度，跟随拖动方向
      const angleTarget = (softMouse[0] - 0.5) * 18 * softInfluence;
      blendAngle += (angleTarget - blendAngle) * (1 - Math.exp(-dt * 2.4));
      program.uniforms.uBlendAngle.value = blendAngle;

      program.uniforms.uMouse.value[0] = softMouse[0];
      program.uniforms.uMouse.value[1] = softMouse[1];
      program.uniforms.uMouseInfluence.value = softInfluence;
      program.uniforms.uMouseVel.value = softSpeed;
      program.uniforms.uRippleAge.value = (performance.now() - rippleAt) * 0.001;
    }

    renderer.render({ scene: mesh });
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('pointerdown', onClick);
    canvas.remove();
  };
}

/* ── Soft Aurora ── */
const SA_VERT = `attribute vec2 uv;attribute vec2 position;varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,0,1);}`;
const SA_FRAG = `precision highp float;
uniform float uTime;uniform vec3 uResolution;uniform float uSpeed;uniform float uScale;
uniform float uBrightness;uniform vec3 uColor1;uniform vec3 uColor2;uniform float uNoiseFreq;
uniform float uNoiseAmp;uniform float uBandHeight;uniform float uBandSpread;uniform float uOctaveDecay;
uniform float uLayerOffset;uniform float uColorSpeed;
#define TAU 6.28318
vec3 gradientHash(vec3 p){p=vec3(dot(p,vec3(127.1,311.7,234.6)),dot(p,vec3(269.5,183.3,198.3)),dot(p,vec3(169.5,283.3,156.9)));vec3 h=fract(sin(p)*43758.5453123);float phi=acos(2.0*h.x-1.0);float theta=TAU*h.y;return vec3(cos(theta)*sin(phi),sin(theta)*cos(phi),cos(phi));}
float quinticSmooth(float t){float t2=t*t,t3=t*t2;return 6.0*t3*t2-15.0*t2*t2+10.0*t3;}
vec3 cosineGradient(float t,vec3 a,vec3 b,vec3 c,vec3 d){return a+b*cos(TAU*(c*t+d));}
float perlin3D(float amplitude,float frequency,float px,float py,float pz){
 float x=px*frequency,y=py*frequency,fx=floor(x),fy=floor(y),fz=floor(pz),cx=ceil(x),cy=ceil(y),cz=ceil(pz);
 vec3 g000=gradientHash(vec3(fx,fy,fz)),g100=gradientHash(vec3(cx,fy,fz)),g010=gradientHash(vec3(fx,cy,fz)),g110=gradientHash(vec3(cx,cy,fz));
 vec3 g001=gradientHash(vec3(fx,fy,cz)),g101=gradientHash(vec3(cx,fy,cz)),g011=gradientHash(vec3(fx,cy,cz)),g111=gradientHash(vec3(cx,cy,cz));
 float d000=dot(g000,vec3(x-fx,y-fy,pz-fz)),d100=dot(g100,vec3(x-cx,y-fy,pz-fz)),d010=dot(g010,vec3(x-fx,y-cy,pz-fz)),d110=dot(g110,vec3(x-cx,y-cy,pz-fz));
 float d001=dot(g001,vec3(x-fx,y-fy,pz-cz)),d101=dot(g101,vec3(x-cx,y-fy,pz-cz)),d011=dot(g011,vec3(x-fx,y-cy,pz-cz)),d111=dot(g111,vec3(x-cx,y-cy,pz-cz));
 float sx=quinticSmooth(x-fx),sy=quinticSmooth(y-fy),sz=quinticSmooth(pz-fz);
 float lx00=mix(d000,d100,sx),lx10=mix(d010,d110,sx),lx01=mix(d001,d101,sx),lx11=mix(d011,d111,sx);
 float ly0=mix(lx00,lx10,sy),ly1=mix(lx01,lx11,sy);
 return amplitude*mix(ly0,ly1,sz);
}
float auroraGlow(float t,vec2 shift){vec2 uv=gl_FragCoord.xy/uResolution.y;uv+=shift;float noiseVal=0.0,freq=uNoiseFreq,amp=uNoiseAmp;vec2 samplePos=uv*uScale;for(float i=0.0;i<3.0;i+=1.0){noiseVal+=perlin3D(amp,freq,samplePos.x,samplePos.y,t);amp*=uOctaveDecay;freq*=2.0;}float yBand=uv.y*10.0-uBandHeight*10.0;return 0.3*max(exp(uBandSpread*(1.0-1.1*abs(noiseVal+yBand))),0.0);}
void main(){
 vec2 uv=gl_FragCoord.xy/uResolution.xy;float t=uSpeed*0.4*uTime;
 vec3 col=vec3(0.0);
 col+=0.99*auroraGlow(t,vec2(0.0))*cosineGradient(uv.x+uTime*uSpeed*0.2*uColorSpeed,vec3(0.5),vec3(0.5),vec3(1.0),vec3(0.3,0.20,0.20))*uColor1;
 col+=0.99*auroraGlow(t+uLayerOffset,vec2(0.0))*cosineGradient(uv.x+uTime*uSpeed*0.1*uColorSpeed,vec3(0.5),vec3(0.5),vec3(2.0,1.0,0.0),vec3(0.5,0.20,0.25))*uColor2;
 col*=uBrightness;float alpha=clamp(length(col),0.0,1.0);gl_FragColor=vec4(col,alpha);
}`;

export function mountSoftAurora(container, opts = {}) {
  const cfg = {
    speed: reduced ? 0 : 0.45,
    scale: 1.4,
    brightness: 0.75,
    color1: '#E8EAEB',
    color2: '#10B981',
    noiseFrequency: 2.2,
    noiseAmplitude: 0.9,
    bandHeight: 0.48,
    bandSpread: 0.95,
    octaveDecay: 0.12,
    layerOffset: 0.15,
    colorSpeed: 0.8,
    ...opts,
  };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  container.appendChild(canvas);

  const renderer = new Renderer({ alpha: true, premultipliedAlpha: false, canvas });
  const gl = renderer.gl;
  gl.clearColor(0, 0, 0, 0);

  const program = new Program(gl, {
    vertex: SA_VERT,
    fragment: SA_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uResolution: { value: [1, 1, 1] },
      uSpeed: { value: cfg.speed },
      uScale: { value: cfg.scale },
      uBrightness: { value: cfg.brightness },
      uColor1: { value: hexToRgb(cfg.color1) },
      uColor2: { value: hexToRgb(cfg.color2) },
      uNoiseFreq: { value: cfg.noiseFrequency },
      uNoiseAmp: { value: cfg.noiseAmplitude },
      uBandHeight: { value: cfg.bandHeight },
      uBandSpread: { value: cfg.bandSpread },
      uOctaveDecay: { value: cfg.octaveDecay },
      uLayerOffset: { value: cfg.layerOffset },
      uColorSpeed: { value: cfg.colorSpeed },
    },
  });
  if (!linkOk(gl, program)) { canvas.remove(); return () => {}; }
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h);
    program.uniforms.uResolution.value = [gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height];
  };
  window.addEventListener('resize', resize);
  resize();

  let frame = 0;
  let alive = true;
  const loop = (t) => {
    if (!alive) return;
    program.uniforms.uTime.value = t * 0.001;
    renderer.render({ scene: mesh });
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    canvas.remove();
  };
}

/* ── Threads ── */
const TH_VERT = `attribute vec2 position;attribute vec2 uv;varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,0.0,1.0);}`;
const TH_FRAG = `precision highp float;
uniform float iTime;uniform vec3 iResolution;uniform vec3 uColor;uniform float uAmplitude;uniform float uDistance;uniform vec2 uMouse;
#define PI 3.1415926538
const int u_line_count=40;const float u_line_width=7.0;const float u_line_blur=10.0;
float Perlin2D(vec2 P){vec2 Pi=floor(P);vec4 Pf_Pfmin1=P.xyxy-vec4(Pi,Pi+1.0);vec4 Pt=vec4(Pi.xy,Pi.xy+1.0);Pt=Pt-floor(Pt*(1.0/71.0))*71.0;Pt+=vec2(26.0,161.0).xyxy;Pt*=Pt;Pt=Pt.xzxz*Pt.yyww;vec4 hash_x=fract(Pt*(1.0/951.135664));vec4 hash_y=fract(Pt*(1.0/642.949883));vec4 grad_x=hash_x-0.49999;vec4 grad_y=hash_y-0.49999;vec4 grad_results=inversesqrt(grad_x*grad_x+grad_y*grad_y)*(grad_x*Pf_Pfmin1.xzxz+grad_y*Pf_Pfmin1.yyww);grad_results*=1.4142135623730950;vec2 blend=Pf_Pfmin1.xy*Pf_Pfmin1.xy*Pf_Pfmin1.xy*(Pf_Pfmin1.xy*(Pf_Pfmin1.xy*6.0-15.0)+10.0);vec4 blend2=vec4(blend,vec2(1.0-blend));return dot(grad_results,blend2.zxzx*blend2.wwyy);}
float pixel(float count,vec2 resolution){return(1.0/max(resolution.x,resolution.y))*count;}
float lineFn(vec2 st,float width,float perc,float offset,vec2 mouse,float time,float amplitude,float distance){
 float split_offset=(perc*0.4);float split_point=0.1+split_offset;float amplitude_normal=smoothstep(split_point,0.7,st.x);float finalAmplitude=amplitude_normal*0.5*amplitude*(1.0+(mouse.y-0.5)*0.2);
 float time_scaled=time/10.0+(mouse.x-0.5)*1.0;float blur=smoothstep(split_point,split_point+0.05,st.x)*perc;
 float xnoise=mix(Perlin2D(vec2(time_scaled,st.x+perc)*2.5),Perlin2D(vec2(time_scaled,st.x+time_scaled)*3.5)/1.5,st.x*0.3);
 float y=0.5+(perc-0.5)*distance+xnoise/2.0*finalAmplitude;
 float line_start=smoothstep(y+(width/2.0)+(u_line_blur*pixel(1.0,iResolution.xy)*blur),y,st.y);
 float line_end=smoothstep(y,y-(width/2.0)-(u_line_blur*pixel(1.0,iResolution.xy)*blur),st.y);
 return clamp((line_start-line_end)*(1.0-smoothstep(0.0,1.0,pow(perc,0.3))),0.0,1.0);
}
void mainImage(out vec4 fragColor,in vec2 fragCoord){
 vec2 uv=fragCoord/iResolution.xy;float line_strength=1.0;
 for(int i=0;i<u_line_count;i++){float p=float(i)/float(u_line_count);line_strength*=(1.0-lineFn(uv,u_line_width*pixel(1.0,iResolution.xy)*(1.0-p),p,PI*p,uMouse,iTime,uAmplitude,uDistance));}
 float colorVal=1.0-line_strength;fragColor=vec4(uColor*colorVal,colorVal);
}
void main(){mainImage(gl_FragColor,gl_FragCoord.xy);}`;

export function mountThreads(container, opts = {}) {
  const rgb = hexToRgb(opts.color || '#10B981');
  const cfg = {
    color: rgb,
    amplitude: opts.amplitude ?? 1.15,
    distance: opts.distance ?? 0.12,
    ...opts,
  };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  container.appendChild(canvas);

  const renderer = new Renderer({ alpha: true, canvas });
  const gl = renderer.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const program = new Program(gl, {
    vertex: TH_VERT,
    fragment: TH_FRAG,
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: new Color(1, 1, 1) },
      uColor: { value: new Color(...cfg.color) },
      uAmplitude: { value: cfg.amplitude },
      uDistance: { value: cfg.distance },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
    },
  });
  if (!linkOk(gl, program)) { canvas.remove(); return () => {}; }
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  const MAX = 1920;
  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const baseDpr = Math.min(devicePixelRatio || 1, 2);
    const longest = Math.max(w, h) * baseDpr;
    renderer.dpr = longest > MAX ? (baseDpr * MAX) / longest : baseDpr;
    renderer.setSize(w, h);
    program.uniforms.iResolution.value.r = gl.canvas.width;
    program.uniforms.iResolution.value.g = gl.canvas.height;
    program.uniforms.iResolution.value.b = gl.canvas.width / gl.canvas.height;
  };
  window.addEventListener('resize', resize);
  resize();

  let frame = 0;
  let alive = true;
  const loop = (t) => {
    if (!alive) return;
    program.uniforms.iTime.value = reduced ? 0 : t * 0.001;
    renderer.render({ scene: mesh });
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    canvas.remove();
  };
}

/* ── Ripple Grid ── */
const RG_VERT = `attribute vec2 position;varying vec2 vUv;void main(){vUv=position*0.5+0.5;gl_Position=vec4(position,0.0,1.0);}`;
const RG_FRAG = `precision highp float;
uniform float iTime;uniform vec2 iResolution;uniform bool enableRainbow;uniform vec3 gridColor;
uniform float rippleIntensity;uniform float gridSize;uniform float gridThickness;uniform float fadeDistance;
uniform float vignetteStrength;uniform float glowIntensity;uniform float opacity;uniform float gridRotation;
varying vec2 vUv;
float pi=3.141592;
mat2 rotate(float angle){float s=sin(angle),c=cos(angle);return mat2(c,-s,s,c);}
void main(){
 vec2 uv=vUv*2.0-1.0;uv.x*=iResolution.x/iResolution.y;
 if(gridRotation!=0.0){uv=rotate(gridRotation*pi/180.0)*uv;}
 float dist=length(uv);float func=sin(pi*(iTime-dist));vec2 rippleUv=uv+uv*func*rippleIntensity;
 vec2 a=sin(gridSize*0.5*pi*rippleUv-pi/2.0);vec2 b=abs(a);float aaWidth=0.5;
 vec2 smoothB=vec2(smoothstep(0.0,aaWidth,b.x),smoothstep(0.0,aaWidth,b.y));
 vec3 color=vec3(0.0);
 color+=exp(-gridThickness*smoothB.x*(0.8+0.5*sin(pi*iTime)));
 color+=exp(-gridThickness*smoothB.y);
 color+=0.5*exp(-(gridThickness/4.0)*sin(smoothB.x));
 color+=0.5*exp(-(gridThickness/3.0)*smoothB.y);
 if(glowIntensity>0.0){color+=glowIntensity*exp(-gridThickness*0.5*smoothB.x);color+=glowIntensity*exp(-gridThickness*0.5*smoothB.y);}
 float ddd=exp(-2.0*clamp(pow(dist,fadeDistance),0.0,1.0));
 float vignette=clamp(1.0-pow(length(vUv-0.5)*2.0,vignetteStrength),0.0,1.0);
 vec3 t=enableRainbow?vec3(uv.x*0.5+0.5*sin(iTime),uv.y*0.5+0.5*cos(iTime),pow(cos(iTime),4.0))+0.5:gridColor;
 float finalFade=ddd*vignette;float alpha=length(color)*finalFade*opacity;
 gl_FragColor=vec4(color*t*finalFade*opacity,alpha);
}`;

export function mountRippleGrid(container, opts = {}) {
  const cfg = {
    gridColor: '#10B981',
    rippleIntensity: 0.04,
    gridSize: 9,
    gridThickness: 12,
    fadeDistance: 1.4,
    vignetteStrength: 1.6,
    glowIntensity: 0.12,
    opacity: 0.42,
    ...opts,
  };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  container.appendChild(canvas);

  const renderer = new Renderer({ alpha: true, dpr: Math.min(devicePixelRatio || 1, 2), canvas });
  const gl = renderer.gl;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const program = new Program(gl, {
    vertex: RG_VERT,
    fragment: RG_FRAG,
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: [1, 1] },
      enableRainbow: { value: false },
      gridColor: { value: hexToRgb(cfg.gridColor) },
      rippleIntensity: { value: cfg.rippleIntensity },
      gridSize: { value: cfg.gridSize },
      gridThickness: { value: cfg.gridThickness },
      fadeDistance: { value: cfg.fadeDistance },
      vignetteStrength: { value: cfg.vignetteStrength },
      glowIntensity: { value: cfg.glowIntensity },
      opacity: { value: cfg.opacity },
      gridRotation: { value: 0 },
    },
  });
  if (!linkOk(gl, program)) { canvas.remove(); return () => {}; }
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h);
    program.uniforms.iResolution.value = [w, h];
  };
  window.addEventListener('resize', resize);
  resize();

  let frame = 0;
  let alive = true;
  const loop = (t) => {
    if (!alive) return;
    program.uniforms.iTime.value = reduced ? 0 : t * 0.001;
    renderer.render({ scene: mesh });
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    canvas.remove();
  };
}

/* ── Light Rays ── */
function rayAnchor(origin, w, h) {
  const o = 0.2;
  switch (origin) {
    case 'top-left': return { anchor: [0, -o * h], dir: [0, 1] };
    case 'top-right': return { anchor: [w, -o * h], dir: [0, 1] };
    default: return { anchor: [0.5 * w, -o * h], dir: [0, 1] };
  }
}

const LR_VERT = RG_VERT;
const LR_FRAG = `precision highp float;
uniform float iTime;uniform vec2 iResolution;uniform vec2 rayPos;uniform vec2 rayDir;
uniform vec3 raysColor;uniform float raysSpeed;uniform float lightSpread;uniform float rayLength;
uniform float pulsating;uniform float fadeDistance;uniform float saturation;uniform float noiseAmount;uniform float distortion;
varying vec2 vUv;
float noise(vec2 st){return fract(sin(dot(st.xy,vec2(12.9898,78.233)))*43758.5453123);}
float rayStrength(vec2 raySource,vec2 rayRefDirection,vec2 coord,float seedA,float seedB,float speed){
 vec2 sourceToCoord=coord-raySource;vec2 dirNorm=normalize(sourceToCoord);float cosAngle=dot(dirNorm,rayRefDirection);
 float distortedAngle=cosAngle+distortion*sin(iTime*2.0+length(sourceToCoord)*0.01)*0.2;
 float spreadFactor=pow(max(distortedAngle,0.0),1.0/max(lightSpread,0.001));
 float distance=length(sourceToCoord);float maxDistance=iResolution.x*rayLength;
 float lengthFalloff=clamp((maxDistance-distance)/maxDistance,0.0,1.0);
 float fadeFalloff=clamp((iResolution.x*fadeDistance-distance)/(iResolution.x*fadeDistance),0.5,1.0);
 float pulse=pulsating>0.5?(0.8+0.2*sin(iTime*speed*3.0)):1.0;
 float baseStrength=clamp((0.45+0.15*sin(distortedAngle*seedA+iTime*speed))+(0.3+0.2*cos(-distortedAngle*seedB+iTime*speed)),0.0,1.0);
 return baseStrength*lengthFalloff*fadeFalloff*spreadFactor*pulse;
}
void main(){
 vec2 coord=vec2(gl_FragCoord.x,iResolution.y-gl_FragCoord.y);
 vec4 rays1=vec4(1.0)*rayStrength(rayPos,rayDir,coord,36.2214,21.11349,1.5*raysSpeed);
 vec4 rays2=vec4(1.0)*rayStrength(rayPos,rayDir,coord,22.3991,18.0234,1.1*raysSpeed);
 vec4 fragColor=rays1*0.5+rays2*0.4;
 if(noiseAmount>0.0){float n=noise(coord*0.01+iTime*0.1);fragColor.rgb*=(1.0-noiseAmount+noiseAmount*n);}
 float brightness=1.0-(coord.y/iResolution.y);
 fragColor.x*=0.1+brightness*0.8;fragColor.y*=0.3+brightness*0.6;fragColor.z*=0.5+brightness*0.5;
 if(saturation!=1.0){float gray=dot(fragColor.rgb,vec3(0.299,0.587,0.114));fragColor.rgb=mix(vec3(gray),fragColor.rgb,saturation);}
 fragColor.rgb*=raysColor;gl_FragColor=fragColor;
}`;

export function mountLightRays(container, opts = {}) {
  const cfg = {
    raysOrigin: 'top-center',
    raysColor: '#10B981',
    raysSpeed: reduced ? 0 : 0.6,
    lightSpread: 0.85,
    rayLength: 1.6,
    fadeDistance: 1.1,
    saturation: 0.9,
    noiseAmount: 0,
    distortion: 0,
    ...opts,
  };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  container.appendChild(canvas);

  const renderer = new Renderer({ alpha: true, dpr: Math.min(devicePixelRatio || 1, 2), canvas });
  const gl = renderer.gl;

  const program = new Program(gl, {
    vertex: LR_VERT,
    fragment: LR_FRAG,
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: [1, 1] },
      rayPos: { value: [0, 0] },
      rayDir: { value: [0, 1] },
      raysColor: { value: hexToRgb(cfg.raysColor) },
      raysSpeed: { value: cfg.raysSpeed },
      lightSpread: { value: cfg.lightSpread },
      rayLength: { value: cfg.rayLength },
      pulsating: { value: 0 },
      fadeDistance: { value: cfg.fadeDistance },
      saturation: { value: cfg.saturation },
      noiseAmount: { value: cfg.noiseAmount },
      distortion: { value: cfg.distortion },
    },
  });
  if (!linkOk(gl, program)) { canvas.remove(); return () => {}; }
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  const place = () => {
    const w = (container.clientWidth || 1) * renderer.dpr;
    const h = (container.clientHeight || 1) * renderer.dpr;
    program.uniforms.iResolution.value = [w, h];
    const { anchor, dir } = rayAnchor(cfg.raysOrigin, w, h);
    program.uniforms.rayPos.value = anchor;
    program.uniforms.rayDir.value = dir;
  };

  const resize = () => {
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    place();
  };
  window.addEventListener('resize', resize);
  resize();

  let frame = 0;
  let alive = true;
  const loop = (t) => {
    if (!alive) return;
    program.uniforms.iTime.value = t * 0.001;
    renderer.render({ scene: mesh });
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    canvas.remove();
  };
}

/* ── Waves（Canvas 2D 线条） ── */
class Grad {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  dot2(x, y) { return this.x * x + this.y * y; }
}

class Noise {
  constructor(seed = 0) {
    this.grad3 = [
      new Grad(1, 1, 0), new Grad(-1, 1, 0), new Grad(1, -1, 0), new Grad(-1, -1, 0),
      new Grad(1, 0, 1), new Grad(-1, 0, 1), new Grad(1, 0, -1), new Grad(-1, 0, -1),
      new Grad(0, 1, 1), new Grad(0, -1, 1), new Grad(0, 1, -1), new Grad(0, -1, -1),
    ];
    this.p = [151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180];
    this.perm = new Array(512);
    this.gradP = new Array(512);
    this.seed(seed);
  }
  seed(seed) {
    if (seed > 0 && seed < 1) seed *= 65536;
    seed = Math.floor(seed);
    if (seed < 256) seed |= seed << 8;
    for (let i = 0; i < 256; i++) {
      const v = (i & 1 ? this.p[i] ^ (seed & 255) : this.p[i] ^ ((seed >> 8) & 255));
      this.perm[i] = this.perm[i + 256] = v;
      this.gradP[i] = this.gradP[i + 256] = this.grad3[v % 12];
    }
  }
  fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(a, b, t) { return (1 - t) * a + t * b; }
  perlin2(x, y) {
    let X = Math.floor(x), Y = Math.floor(y);
    x -= X; y -= Y; X &= 255; Y &= 255;
    const n00 = this.gradP[X + this.perm[Y]].dot2(x, y);
    const n01 = this.gradP[X + this.perm[Y + 1]].dot2(x, y - 1);
    const n10 = this.gradP[X + 1 + this.perm[Y]].dot2(x - 1, y);
    const n11 = this.gradP[X + 1 + this.perm[Y + 1]].dot2(x - 1, y - 1);
    const u = this.fade(x);
    return this.lerp(this.lerp(n00, n10, u), this.lerp(n01, n11, u), this.fade(y));
  }
}

export function mountWaves(container, opts = {}) {
  const cfg = {
    lineColor: '#10B981',
    waveSpeedX: reduced ? 0 : 0.0125,
    waveSpeedY: reduced ? 0 : 0.005,
    waveAmpX: 28,
    waveAmpY: 14,
    xGap: 11,
    yGap: 30,
    ...opts,
  };

  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%;height:100%;position:relative;background:#E8EAEB';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  wrap.appendChild(canvas);
  container.appendChild(wrap);

  const ctx = canvas.getContext('2d');
  const noise = new Noise(7);
  let lines = [];
  let bounds = { width: 0, height: 0 };
  const mouse = { x: -10, y: 0, lx: 0, ly: 0, sx: 0, sy: 0, v: 0, vs: 0, a: 0, set: false };

  function setSize() {
    bounds = { width: wrap.clientWidth, height: wrap.clientHeight };
    canvas.width = bounds.width;
    canvas.height = bounds.height;
  }

  function setLines() {
    lines = [];
    const { width, height } = bounds;
    const oW = width + 200, oH = height + 30;
    const totalLines = Math.ceil(oW / cfg.xGap);
    const totalPoints = Math.ceil(oH / cfg.yGap);
    const xStart = (width - cfg.xGap * totalLines) / 2;
    const yStart = (height - cfg.yGap * totalPoints) / 2;
    for (let i = 0; i <= totalLines; i++) {
      const pts = [];
      for (let j = 0; j <= totalPoints; j++) {
        pts.push({ x: xStart + cfg.xGap * i, y: yStart + cfg.yGap * j, wave: { x: 0, y: 0 }, cursor: { x: 0, y: 0, vx: 0, vy: 0 } });
      }
      lines.push(pts);
    }
  }

  function moved(p, withCursor = true) {
    return {
      x: Math.round((p.x + p.wave.x + (withCursor ? p.cursor.x : 0)) * 10) / 10,
      y: Math.round((p.y + p.wave.y + (withCursor ? p.cursor.y : 0)) * 10) / 10,
    };
  }

  function tick(t) {
    mouse.sx += (mouse.x - mouse.sx) * 0.1;
    mouse.sy += (mouse.y - mouse.sy) * 0.1;
    const dx = mouse.x - mouse.lx, dy = mouse.y - mouse.ly;
    const d = Math.hypot(dx, dy);
    mouse.v = d; mouse.vs += (d - mouse.vs) * 0.1; mouse.vs = Math.min(100, mouse.vs);
    mouse.lx = mouse.x; mouse.ly = mouse.y; mouse.a = Math.atan2(dy, dx);

    for (const pts of lines) {
      for (const p of pts) {
        const move = noise.perlin2((p.x + t * cfg.waveSpeedX) * 0.002, (p.y + t * cfg.waveSpeedY) * 0.0015) * 12;
        p.wave.x = Math.cos(move) * cfg.waveAmpX;
        p.wave.y = Math.sin(move) * cfg.waveAmpY;
        p.cursor.vx += (0 - p.cursor.x) * 0.005;
        p.cursor.vy += (0 - p.cursor.y) * 0.005;
        p.cursor.vx *= 0.925; p.cursor.vy *= 0.925;
        p.cursor.x += p.cursor.vx * 2; p.cursor.y += p.cursor.vy * 2;
      }
    }

    ctx.clearRect(0, 0, bounds.width, bounds.height);
    ctx.beginPath();
    ctx.strokeStyle = cfg.lineColor;
    ctx.globalAlpha = 0.55;
    for (const points of lines) {
      let p1 = moved(points[0], false);
      ctx.moveTo(p1.x, p1.y);
      for (let idx = 0; idx < points.length; idx++) {
        const isLast = idx === points.length - 1;
        p1 = moved(points[idx], !isLast);
        const p2 = moved(points[idx + 1] || points[points.length - 1], !isLast);
        ctx.lineTo(p1.x, p1.y);
        if (isLast) ctx.moveTo(p2.x, p2.y);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    frame = requestAnimationFrame(tick);
  }

  const onResize = () => { setSize(); setLines(); };
  window.addEventListener('resize', onResize);
  setSize(); setLines();

  let frame = 0;
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', onResize);
    wrap.remove();
  };
}

export function mountGrainientLogin(container, overrides = {}) {
  return mountGrainient(container, overrides);
}

/** demo 路由 */
const RB_MOUNT = {
  grainient: mountGrainient,
  'soft-aurora': mountSoftAurora,
  threads: mountThreads,
  'ripple-grid': mountRippleGrid,
  'light-rays': mountLightRays,
  waves: mountWaves,
};

export function mountReactBitsBg(container, variant) {
  const fn = RB_MOUNT[variant];
  if (!fn) return () => {};
  return fn(container);
}
