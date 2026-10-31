// 真实产品/BFF 的回环测试宿主；不运行 main 的外部服务、轮询和业务种子。
import {resolve,dirname,basename} from 'node:path';
const root=resolve(process.argv[2]||'');
if(dirname(root)!=='/private/tmp'||!basename(root).startsWith('shangshu-agent-probe.'))throw Error('仅允许专用临时目录');
process.env._SS_DATA_DIR=root+'/node-browser';
process.env.SHANGSHU_PLATFORM_MODE='frappe';
process.env.FRAPPE_UPSTREAM='http://127.0.0.1:18741';
process.env.SS_COOKIE_SECURE='0';
const {buildApp}=await import('../shangshu-server/src/adapters/web/server.ts');
buildApp().listen(18742,'127.0.0.1',()=>console.log('A browser probe: http://127.0.0.1:18742'));
