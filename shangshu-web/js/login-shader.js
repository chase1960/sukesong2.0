/* 登录页背景：Paper Shaders MeshGradient（v0.1 中性灰 + 浅绿语义色） */
import {
  ShaderMount,
  meshGradientFragmentShader,
  getShaderColorFromString,
  ShaderFitOptions,
  defaultObjectSizing,
} from 'https://esm.sh/@paper-design/shaders@0.0.80';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const container = document.getElementById('shader-bg');
if (!container) throw new Error('missing #shader-bg');

const uniforms = {
  u_colors: ['#E8EAEB', '#EFF0F1', '#E9F8F1', '#D8EBE3'].map(getShaderColorFromString),
  u_colorsCount: 4,
  u_distortion: 0.32,
  u_swirl: 0.12,
  u_grainMixer: 0.06,
  u_grainOverlay: 0.04,
  u_fit: ShaderFitOptions[defaultObjectSizing.fit],
  u_rotation: 0,
  u_scale: 1,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 1000,
  u_worldHeight: 1000,
};

new ShaderMount(
  container,
  meshGradientFragmentShader,
  uniforms,
  {},
  reduced ? 0 : 0.07,
  0,
);
