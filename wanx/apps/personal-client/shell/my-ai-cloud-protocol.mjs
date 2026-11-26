import { randomUUID } from "node:crypto";

const invalid = () => Object.assign(new Error("云模型验收版支持文字会话，此请求含有未支持的内容。"), { status: 422 });

function content(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw invalid();
  return value.map(part => {
    if ((!part.type || ["text", "input_text", "output_text"].includes(part.type)) && typeof part.text === "string") return part.text;
    throw invalid();
  }).join("\n");
}

export function parseCloudTurn(agent, route, body) {
  const messages = [];
  const add = (role, value) => {
    const text = content(value);
    if (text) messages.push({ role, content: text });
  };
  if ((agent === "codex_cli" || agent === "codex") && route === "/v1/responses") {
    if (body.instructions) add("system", body.instructions);
    if (typeof body.input === "string") add("user", body.input);
    else for (const item of body.input ?? []) {
      if (item.type === "reasoning") continue;
      if (!["developer", "system", "user", "assistant"].includes(item.role)) throw invalid();
      add(item.role === "developer" ? "system" : item.role, item.content);
    }
  } else if (agent === "claude_code" && route === "/v1/messages") {
    if (body.system) add("system", body.system);
    for (const message of body.messages ?? []) {
      if (!["user", "assistant"].includes(message.role)) throw invalid();
      add(message.role, message.content);
    }
  } else if (agent === "gemini" && /^\/(?:v1(?:beta(?:1)?)?\/)?models\/[^/]+:(streamGenerateContent|generateContent)$/.test(route)) {
    const instruction = body.systemInstruction ?? body.system_instruction;
    if (instruction?.parts) add("system", instruction.parts);
    for (const item of body.contents ?? []) {
      if (item.role && !["user", "model"].includes(item.role)) throw invalid();
      add(item.role === "model" ? "assistant" : "user", item.parts);
    }
  } else throw invalid();
  if (!messages.some(m => m.role === "user")) throw invalid();
  messages.unshift({ role: "system", content: "This session supports text conversations. Answer in text. Tools are unavailable. Do not claim to have used one." });
  return { messages, maxTokens: Math.max(1, Math.min(8192, Number(body.max_output_tokens || body.max_tokens || body.generationConfig?.maxOutputTokens) || 4096)) };
}

export function sendCloudAnswer(res, agent, body, route, answer) {
  const id = randomUUID().replaceAll("-", "");
  const { text, model } = answer;
  const usage = answer.usage ?? {};
  const input = usage.input_tokens ?? 0, output = usage.output_tokens ?? 0;
  const stream = body.stream === true || route.endsWith(":streamGenerateContent");
  res.writeHead(200, {"content-type": stream ? "text/event-stream" : "application/json", "cache-control":"no-store"});
  const event = (type, value) => res.write((type ? "event: " + type + "\n" : "") + "data: " + JSON.stringify(value) + "\n\n");
  if (agent === "gemini") {
    const result = { candidates: [{index:0, content:{role:"model",parts:[{text}]}, finishReason:"STOP"}], modelVersion:model,
      usageMetadata:{promptTokenCount:input,candidatesTokenCount:output,totalTokenCount:input+output} };
    if (!stream) return res.end(JSON.stringify(result));
    event("", result);
  } else if (agent === "claude_code") {
    const message = {id:"msg_"+id,type:"message",role:"assistant",model,content:[{type:"text",text}],stop_reason:"end_turn",stop_sequence:null,
      usage:{input_tokens:input,output_tokens:output}};
    if (!stream) return res.end(JSON.stringify(message));
    const send = (type, fields) => event(type, {type,...fields});
    send("message_start",{message:{...message,content:[],stop_reason:null,usage:{input_tokens:input,output_tokens:0}}});
    send("content_block_start",{index:0,content_block:{type:"text",text:""}});
    send("content_block_delta",{index:0,delta:{type:"text_delta",text}});
    send("content_block_stop",{index:0});
    send("message_delta",{delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:output}});
    send("message_stop",{});
  } else {
    const part = {type:"output_text",text,annotations:[]};
    const item = {id:"msg_"+id,type:"message",status:"completed",role:"assistant",content:[part]};
    const response = {id:"resp_"+id,object:"response",created_at:Math.floor(Date.now()/1000),status:"completed",model,
      output:[item],usage:{input_tokens:input,output_tokens:output,total_tokens:input+output},error:null};
    if (!stream) return res.end(JSON.stringify(response));
    let sequence = 0;
    const send = (type,fields) => event(type,{type,sequence_number:sequence++,...fields});
    const pos = {output_index:0,item_id:item.id,content_index:0};
    send("response.created",{response:{...response,output:[],status:"in_progress",usage:null}});
    send("response.output_item.added",{output_index:0,item:{...item,status:"in_progress",content:[]}});
    send("response.content_part.added",{...pos,part:{...part,text:""}});
    send("response.output_text.delta",{...pos,delta:text});
    send("response.output_text.done",{...pos,text});
    send("response.content_part.done",{...pos,part});
    send("response.output_item.done",{output_index:0,item});
    send("response.completed",{response});
  }
  res.end();
}

export function cloudCliOptions(route) {
  if (!route) return { args: [], env: {} };
  const { agent, port, token, model } = route;
  if (!["codex_cli","claude_code","gemini"].includes(agent) || !Number.isInteger(port) || port < 1 || port > 65535
      || !/^[a-f0-9]{64}$/.test(token) || typeof model !== "string" || !model || model.length > 256) throw invalid();
  const base = "http://127.0.0.1:" + port;
  if (agent === "codex_cli") return { args: ["-m",model,"-c",'model_provider="memobox_cloud"',"-c",'model_providers.memobox_cloud.name="MemoBox Cloud"',
    "-c","model_providers.memobox_cloud.base_url="+JSON.stringify(base+"/v1"),"-c",'model_providers.memobox_cloud.env_key="MEMOBOX_SESSION_TOKEN"',
    "-c",'model_providers.memobox_cloud.wire_api="responses"',"-c","model_providers.memobox_cloud.supports_websockets=false"],env:{MEMOBOX_SESSION_TOKEN:token} };
  if (agent === "claude_code") return {args:["--bare","--model",model,"--tools",""],
    env:{ANTHROPIC_BASE_URL:base,ANTHROPIC_API_KEY:token,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",
      CLAUDE_CODE_USE_BEDROCK:"0",CLAUDE_CODE_USE_VERTEX:"0",CLAUDE_CODE_USE_FOUNDRY:"0",ANTHROPIC_AUTH_TOKEN:"",CLAUDE_CODE_OAUTH_TOKEN:""}};
  return {args:["--settings",JSON.stringify({modelProvider:"gemini"})],env:{GEMINI_API_KEY:token,GOOGLE_GEMINI_BASE_URL:base}};
}
