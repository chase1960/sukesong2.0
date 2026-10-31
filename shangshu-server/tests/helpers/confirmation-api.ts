import {readFileSync} from 'node:fs';

/** 使用生产公共确认接口封装，不用测试私造的同名实现遮住加载依赖。 */
export function installConfirmationApi(w:any) {
  const app=readFileSync(new URL('../../../shangshu-web/js/app.js',import.meta.url),'utf8');
  w.apiJSON ||= async(path:string)=>(await w.api(path)).json();
  w.eval(app.slice(app.indexOf('const CONFIRM_LIST_URL'),app.indexOf('async function logout')));
}
