/* 可控桩 LLM：只回 platform_action_call(mail.save_draft)。

为什么要有它：真实模型不在这台机器上（宿主 Ollama 172.30.0.1:11434 实测 HTTP 000）。
**这个桩只替「模型出工具调用」那一步，对话链路本身全是真的** ——
登录 → POST /api/chat → chatCompletionsStream → 工具执行器 → 内核提案 → 人审。
标注清楚：真实模型那一步仍未验。

跑法：在 **node 容器内**起（127.0.0.1 才可达）：
  docker exec -d shangshu-local-c-node-1 node /tmp/stub-llm.mjs 11435
注意：`docker compose restart node` 会把它一起带掉，重启后要重起。
*/
import {createServer} from 'node:http';
const PORT = Number(process.argv[2] || 11435);
const payload = {subject:'助手起草：10 月对账单', body:'李经理您好，本月对账单见下。\n——\n王五',
  to:['li@client.example.invalid'], cc:[], expected_version:1};
const toolArgs = JSON.stringify({action_id:'mail.save_draft', payload});
const lines = [
  'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-stub-1","type":"function","function":{"name":"platform_action_call","arguments":' + JSON.stringify(toolArgs) + '}}]},"index":0}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
  'data: [DONE]',
];
createServer((req,res)=>{
  let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
    if(!req.url.includes('/chat/completions')){res.statusCode=404;res.end('no');return;}
    res.setHeader('Content-Type','text/event-stream');
    for(const l of lines) res.write(l+'\n\n');
    res.end();
  });
}).listen(PORT,'127.0.0.1',()=>console.log('stub-llm on',PORT));
