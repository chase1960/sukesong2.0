import * as latestRead from '../../../shangshu-web/js/lib/latest-read.mjs';

/** JSDOM's eval cannot import ESM; inject the actual shared module at that boundary. */
export function browserModuleSource(window:any,source:string):string {
  window.__latestReadModule=latestRead;
  return source.replaceAll("import('./lib/latest-read.mjs')",'Promise.resolve(window.__latestReadModule)');
}
