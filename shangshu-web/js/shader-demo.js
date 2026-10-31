/* 登录页背景选型板 — Paper Shaders + react-bits */
import { mountDarkVeil, mountDarkVeilGreen, mountDarkVeilLight } from './dark-veil.js';
import { mountReactBitsBg, mountGrainient } from './react-bits-bg.js';
import { mountSplashCursor } from './splash-cursor.js';
import {
  ShaderMount,
  meshGradientFragmentShader,
  grainGradientFragmentShader,
  godRaysFragmentShader,
  neuroNoiseFragmentShader,
  smokeRingFragmentShader,
  dotOrbitFragmentShader,
  warpFragmentShader,
  metaballsFragmentShader,
  swirlFragmentShader,
  getShaderColorFromString,
  getShaderNoiseTexture,
  ShaderFitOptions,
  GrainGradientShapes,
  WarpPatterns,
} from 'https://esm.sh/@paper-design/shaders@0.0.80';

const SPEED = 0.35;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const speed = reduced ? 0 : SPEED;

function fit() {
  return {
    u_fit: ShaderFitOptions.contain,
    u_scale: 1,
    u_rotation: 0,
    u_offsetX: 0,
    u_offsetY: 0,
    u_originX: 0.5,
    u_originY: 0.5,
    u_worldWidth: 0,
    u_worldHeight: 0,
  };
}

function cols(list) {
  return list.map(getShaderColorFromString);
}

function noiseTextureReady() {
  return new Promise((resolve) => {
    const tex = getShaderNoiseTexture();
    if (!tex) { resolve(null); return; }
    if (tex.complete && tex.naturalWidth) { resolve(tex); return; }
    tex.addEventListener('load', () => resolve(tex), { once: true });
    tex.addEventListener('error', () => resolve(tex), { once: true });
  });
}

/** @type {Array<{id:string,name:string,tag:string,desc:string,shader?:object,uniforms?:object,speed?:number,engine?:string,variant?:string}>} */
const DEMOS = [
  /* react-bits 尚书推荐 */
  {
    id: 'rb-grainient-splash',
    name: 'Grainient + Splash Cursor',
    tag: '推荐',
    desc: '当前 login：纸纹底 + reactbits 流体墨迹跟手拖动（非戳鼓包）。',
    engine: 'react-bits',
    variant: 'grainient-splash',
  },
  {
    id: 'rb-grainient',
    name: 'Grainient · 纸纹',
    tag: '尚书',
    desc: '仅纸纹底（无流体）。login 已叠 Splash Cursor。',
    engine: 'react-bits',
    variant: 'grainient',
  },
  {
    id: 'rb-ripple-grid',
    name: 'Ripple Grid · 账格',
    tag: '尚书',
    desc: '网格涟漪，台账/表格语言，数据在格子里流动。',
    engine: 'react-bits',
    variant: 'ripple-grid',
  },
  {
    id: 'rb-soft-aurora',
    name: 'Soft Aurora · 晨光',
    tag: '尚书',
    desc: '柔和极光，晨光映案，清稳不 flashy。',
    engine: 'react-bits',
    variant: 'soft-aurora',
  },
  {
    id: 'rb-threads',
    name: 'Threads · 经线',
    tag: '尚书',
    desc: '织物般流动线条，多路信息织成一本「书」。',
    engine: 'react-bits',
    variant: 'threads',
  },
  {
    id: 'rb-waves',
    name: 'Waves · 流水',
    tag: '尚书',
    desc: 'Canvas 层叠波纹线，流水账 / 笔意连绵，纯 2D 轻量。',
    engine: 'react-bits',
    variant: 'waves',
  },
  {
    id: 'rb-light-rays',
    name: 'Light Rays · 明察',
    tag: '尚书',
    desc: '顶部绿色光束洒下，照见经营事项。',
    engine: 'react-bits',
    variant: 'light-rays',
  },
  /* Dark Veil 系列 */
  {
    id: 'dark-veil-light',
    name: 'Dark Veil · 浅底绿纹',
    tag: 'React Bits',
    desc: '浅灰底 + 淡绿 CPPN 纹理。',
    engine: 'dark-veil',
    variant: 'light',
  },
  {
    id: 'dark-veil',
    name: 'Dark Veil · 原版',
    tag: '对比',
    desc: 'reactbits 原版紫黑暗流，供对比。',
    engine: 'dark-veil',
    variant: 'default',
  },
  {
    id: 'dark-veil-green',
    name: 'Dark Veil · 深绿',
    tag: '对比',
    desc: '深色底 + 绿色色相。',
    engine: 'dark-veil',
    variant: 'green',
  },
  /* Paper Shaders */
  {
    id: 'mesh-green',
    name: 'Mesh Gradient · 品牌绿',
    tag: 'Paper',
    desc: '四色流动渐变，绿为主、对比明显。',
    shader: meshGradientFragmentShader,
    uniforms: {
      u_colors: cols(['#E8EAEB', '#10B981', '#0EA372', '#34D399']),
      u_colorsCount: 4,
      u_distortion: 0.75,
      u_swirl: 0.35,
      u_grainMixer: 0.12,
      u_grainOverlay: 0.08,
      ...fit(),
    },
  },
  {
    id: 'mesh-soft',
    name: 'Mesh Gradient · 淡色',
    tag: 'Paper',
    desc: '淡色 Mesh 渐变，几乎看不见时可对比。',
    shader: meshGradientFragmentShader,
    uniforms: {
      u_colors: cols(['#E8EAEB', '#EFF0F1', '#E9F8F1', '#D8EBE3']),
      u_colorsCount: 4,
      u_distortion: 0.32,
      u_swirl: 0.12,
      u_grainMixer: 0.06,
      u_grainOverlay: 0.04,
      ...fit(),
    },
    speed: 0.07,
  },
  {
    id: 'grain-wave',
    name: 'Grain Gradient · 波浪',
    tag: 'Paper',
    desc: '带颗粒感的波浪色带，浅底 + 绿色流动。',
    shader: grainGradientFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString('#E8EAEB'),
      u_colors: cols(['#E9F8F1', '#10B981', '#0EA372', '#2563EB']),
      u_colorsCount: 4,
      u_shape: GrainGradientShapes.wave,
      u_softness: 0.65,
      u_intensity: 0.55,
      u_noise: 0.18,
      u_noiseTexture: getShaderNoiseTexture(),
      ...fit(),
    },
  },
  {
    id: 'grain-blob',
    name: 'Grain Gradient · 有机块',
    tag: 'Paper',
    desc: 'blob 形状缓慢变形，绿色块在灰底上漂移。',
    shader: grainGradientFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString('#EFF0F1'),
      u_colors: cols(['#D8EBE3', '#10B981', '#34D399', '#E9F8F1']),
      u_colorsCount: 4,
      u_shape: GrainGradientShapes.blob,
      u_softness: 0.8,
      u_intensity: 0.45,
      u_noise: 0.12,
      u_noiseTexture: getShaderNoiseTexture(),
      ...fit(),
    },
  },
  {
    id: 'god-rays',
    name: 'God Rays · 顶光',
    tag: 'Paper',
    desc: '从上方射下的绿色光束，卡片毛玻璃会很出效果。',
    shader: godRaysFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString('#E8EAEB'),
      u_colorBloom: getShaderColorFromString('#10B981'),
      u_colors: cols(['#E9F8F180', '#10B981CC', '#0EA372', '#ffffff']),
      u_colorsCount: 4,
      u_density: 0.35,
      u_spotty: 0.25,
      u_midIntensity: 0.5,
      u_midSize: 0.25,
      u_intensity: 0.7,
      u_bloom: 0.35,
      u_noiseTexture: getShaderNoiseTexture(),
      ...fit(),
      u_offsetY: -0.4,
    },
    speed: 0.25,
  },
  {
    id: 'neuro-green',
    name: 'Neuro Noise · 神经网络',
    tag: 'Paper',
    desc: '发光线条网络，绿色节点，偏 AI 科技感。',
    shader: neuroNoiseFragmentShader,
    uniforms: {
      u_colorFront: getShaderColorFromString('#ffffff'),
      u_colorMid: getShaderColorFromString('#10B981'),
      u_colorBack: getShaderColorFromString('#E8EAEB'),
      u_brightness: 0.12,
      u_contrast: 0.45,
      ...fit(),
    },
  },
  {
    id: 'smoke-ring',
    name: 'Smoke Ring · 烟环',
    tag: 'Paper',
    desc: '中心扩散的彩色烟环，绿色渐变，有体积感。',
    shader: smokeRingFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString('#E8EAEB'),
      u_colors: cols(['#E9F8F1', '#10B981', '#0EA372']),
      u_colorsCount: 3,
      u_noiseScale: 2.5,
      u_noiseIterations: 6,
      u_radius: 0.35,
      u_thickness: 0.7,
      u_innerShape: 1.2,
      u_noiseTexture: getShaderNoiseTexture(),
      ...fit(),
    },
    speed: 0.2,
  },
  {
    id: 'dot-orbit',
    name: 'Dot Orbit · 点阵',
    tag: 'Paper',
    desc: '多色小点轨道运动，绿色系，比原 canvas 点阵更精致。',
    shader: dotOrbitFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString('#E8EAEB'),
      u_colors: cols(['#E9F8F1', '#10B981', '#0EA372', '#34D399', '#EFF0F1']),
      u_colorsCount: 5,
      u_size: 0.55,
      u_sizeRange: 0.3,
      u_spreading: 0.6,
      u_stepsPerColor: 3,
      u_noiseTexture: getShaderNoiseTexture(),
      ...fit(),
    },
    speed: 0.5,
  },
  {
    id: 'warp-kelp',
    name: 'Warp · 海藻流',
    tag: 'Paper',
    desc: '条纹基底 + 扭曲流动，绿色海藻感，动态明显。',
    shader: warpFragmentShader,
    uniforms: {
      u_colors: cols(['#E8EAEB', '#10B981', '#E8EAEB', '#0EA372', '#34D399']),
      u_colorsCount: 5,
      u_proportion: 0.5,
      u_softness: 0.85,
      u_shape: WarpPatterns.stripes,
      u_shapeScale: 0.15,
      u_distortion: 0.4,
      u_swirl: 0.5,
      u_swirlIterations: 8,
      u_noiseTexture: getShaderNoiseTexture(),
      ...fit(),
    },
  },
  {
    id: 'metaballs-soft',
    name: 'Metaballs · 软气泡',
    tag: 'Paper',
    desc: '多个绿色气泡融合漂移，动态柔和。',
    shader: metaballsFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString('#E8EAEB'),
      u_colors: cols(['#E9F8F1', '#10B981', '#0EA372', '#34D399']),
      u_colorsCount: 4,
      u_count: 8,
      u_size: 0.75,
      u_noiseTexture: getShaderNoiseTexture(),
      ...fit(),
    },
    speed: 0.3,
  },
  {
    id: 'swirl-green',
    name: 'Swirl · 旋涡',
    tag: 'Paper',
    desc: '绿色色带绕中心旋转，中心放登录卡片很合适。',
    shader: swirlFragmentShader,
    uniforms: {
      u_colorBack: getShaderColorFromString('#E8EAEB'),
      u_colors: cols(['#E9F8F1', '#10B981', '#0EA372']),
      u_colorsCount: 3,
      u_bandCount: 5,
      u_twist: 0.25,
      u_center: 0.15,
      u_proportion: 0.5,
      u_softness: 0.5,
      u_noiseFrequency: 0.35,
      u_noise: 0.15,
      ...fit(),
    },
    speed: 0.28,
  },
];

const grid = document.getElementById('grid');
const toast = document.getElementById('toast');
const errEl = document.getElementById('err');
const countEl = document.getElementById('demo-count');
let selected = null;
let toastTimer = 0;

if (countEl) countEl.textContent = String(DEMOS.length);

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function cardHtml(d) {
  return `
    <article class="demo" data-id="${d.id}">
      <div class="demo-preview">
        <div class="shader-host" id="host-${d.id}"></div>
        <div class="demo-mock">
          <div class="demo-card">
            <b>欢迎回来</b>
            <div class="line"></div>
            <div class="line w60"></div>
            <div class="btn-mock"></div>
          </div>
        </div>
      </div>
      <div class="demo-meta">
        <span class="tag">${d.tag}</span>
        <h2>${d.name}</h2>
        <p>${d.desc}</p>
        <button type="button" class="pick" data-id="${d.id}">选用此效果 · ${d.id}</button>
      </div>
    </article>`;
}

grid.innerHTML = DEMOS.map(cardHtml).join('');

const mounts = [];
const errors = [];

const noiseTex = await noiseTextureReady();

for (const d of DEMOS) {
  const host = document.getElementById(`host-${d.id}`);
  if (!host) continue;
  try {
    if (d.engine === 'react-bits') {
      if (d.variant === 'grainient-splash') {
        const paper = document.createElement('div');
        paper.style.cssText = 'position:absolute;inset:0';
        const fluid = document.createElement('div');
        fluid.style.cssText = 'position:absolute;inset:0;mix-blend-mode:multiply;pointer-events:none';
        host.style.position = 'relative';
        host.appendChild(paper);
        host.appendChild(fluid);
        const d1 = mountGrainient(paper, { interactive: false });
        const d2 = mountSplashCursor(fluid, {
          COLOR: '#059669',
          RAINBOW_MODE: false,
          DENSITY_DISSIPATION: 1.15,
          VELOCITY_DISSIPATION: 0.95,
          SPLAT_FORCE: 7200,
          SPLAT_RADIUS: 0.28,
        });
        mounts.push({ dispose: () => { d1(); d2(); } });
        continue;
      }
      mounts.push({ dispose: mountReactBitsBg(host, d.variant) });
      continue;
    }
    if (d.engine === 'dark-veil') {
      const fn = d.variant === 'light'
        ? mountDarkVeilLight
        : d.variant === 'green'
          ? mountDarkVeilGreen
          : mountDarkVeil;
      mounts.push({ dispose: fn(host) });
      continue;
    }
    const uniforms = { ...d.uniforms };
    if ('u_noiseTexture' in uniforms && noiseTex) uniforms.u_noiseTexture = noiseTex;
    mounts.push(new ShaderMount(host, d.shader, uniforms, {}, d.speed ?? speed, 0));
  } catch (e) {
    errors.push(`${d.id}: ${e.message || e}`);
    host.innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#DC4444;font-size:12px;padding:16px;text-align:center">加载失败<br>${d.id}</div>`;
  }
}

if (errors.length) {
  errEl.style.display = 'block';
  errEl.textContent = `部分效果未能加载：${errors.join(' · ')}`;
}

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.pick');
  if (!btn) return;
  const id = btn.dataset.id;
  selected = id;
  $$('.demo').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  navigator.clipboard?.writeText(id).catch(() => {});
  showToast(`已选用：${id}（ID 已复制，告诉我编号即可）`);
});

function $$(sel) { return [...document.querySelectorAll(sel)]; }
