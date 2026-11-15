"""Isolated test harness only: actual workshop runtime, synthetic files and model."""

import json
import os
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))
from wanx_studio.contracts import StudioError  # noqa: E402
from wanx_studio.runner import Runner  # noqa: E402
from wanx_studio.workshop import PersonalWorkshop  # noqa: E402

class Models:
    def runtime_catalog(self):
        return {"models": [{"id": "fixture", "name": "合成模型", "provider": "isolated"}], "defaultId": "fixture"}

service = PersonalWorkshop(Path(tempfile.mkdtemp(prefix="wanx-template-synthetic-")), root, Models())
class Knowledge:
    async def catalog(self, owner):
        return [{"id":"fixture-knowledge","name":"合成星图知识"}]
    async def read(self, owner, action, params):
        if action == "evidence":
            return {"text":"申请培训证明请在学习中心提交申请。"}
        return {"items":[{"id":"fixture-evidence","document_name":"合成培训说明","text":"申请培训证明请在学习中心提交申请。"}]}
service.knowledge_provider = Knowledge()
service.runner = Runner(service)


async def fake_files(owner, ids):
    return [
        {
            "id": "fixture",
            "name": "合成培训说明.txt",
            "text": "申请培训证明请在学习中心提交申请，由培训负责人核对学习记录。\n\n培训证明申请应注明姓名和培训课程。",
        }
    ]


service.files = fake_files


async def fake_generate(owner, project, body, **kwargs):
    prompt = body["messages"][0]["content"]
    if "候选标准问答" in prompt:
        value = {
            "items": [
                {
                    "question": "培训证明怎样申请",
                    "answer": "请在学习中心提交申请。",
                    "category": "培训",
                }
            ]
        }
    elif "资料没有依据的问题" in prompt:
        value = {
            "items": [
                {"question": "培训证明申请", "expected": "answer", "contains": "学习中心"},
                {"question": "银河火山", "expected": "handoff", "contains": ""},
            ]
        }
    elif "你是问答助手" in prompt:
        context = json.loads(prompt.split("\n", 1)[1])
        if context["evidence"]:
            e = context["evidence"][0]
            value = {"grounded":e["text"]+"[1]","claims":[{"id":"1","quote":e["text"][:20]}],"supplement":"通用建议：可提前整理相关材料。"}
        else:
            return {"choices":[{"message":{"content":"这是通用问答示例。可以继续追问，也可以按需添加资料。"}}]}
    else:
        context = json.loads(prompt.split("\n", 1)[1])
        source = context["evidence"][0]
        value = {
            "answer": source["text"] + "[" + source["id"] + "]",
            "claims": [{"id": source["id"], "quote": source["text"][:40]}],
        }
    return {"choices": [{"message": {"content": json.dumps(value, ensure_ascii=False)}}]}


service.generate = fake_generate
state = {}


@asynccontextmanager
async def lifespan(app):
    source = json.loads((root / "templates/knowledge-qa/wanx.editable.json").read_text())
    p = await service.copy_source(
        "synthetic", {"operationId": uuid4().hex, "name": "智能客服", "source": source}
    )
    a = p["artifacts"][0]
    state["session"] = service.open_runtime("synthetic", p["id"], a["hash"], "preview")["session"]
    yield
    await service.close()


app = FastAPI(lifespan=lifespan)


@app.exception_handler(StudioError)
async def error(request, e):
    return JSONResponse({"code": e.code}, e.status)


@app.middleware("http")
async def boundary(request, call_next):
    if request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"code": "ORIGIN_DENIED"}, 403)
    return await call_next(request)


@app.get("/")
async def index():
    return HTMLResponse(
        """<!doctype html><html><head><meta charset="utf-8"><title>知识问答模板 · 隔离验证</title><style>body{margin:0;background:#faf7f2;font:12px system-ui}header{padding:8px 16px;background:#f3ece2;color:#686159}iframe{display:block;width:100%;height:calc(100vh - 34px);border:0}</style></head><body><header>隔离验证：真实工坊沙箱与数据运行时 · 合成资料 · 模拟模型 · 未安装到万象客户端</header><iframe title="模板验证" sandbox="allow-scripts allow-forms" src="/frame"></iframe><script>const frame=document.querySelector('iframe');frame.onload=()=>{const channel=new MessageChannel();let pending=0;channel.port1.onmessage=async({data:m})=>{if(!Number.isSafeInteger(m?.id)||pending>=4)return;pending++;try{const r=await fetch('/invoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:m.method,params:m.params||{}})});const v=await r.json();channel.port1.postMessage(r.ok?{id:m.id,result:v}:{id:m.id,error:v.code||'FAILED'})}catch{channel.port1.postMessage({id:m.id,error:'FAILED'})}finally{pending--}};frame.contentWindow.postMessage({type:'wanx:init'},'*',[channel.port2])};</script></body></html>"""
    )


@app.get("/frame")
async def frame():
    return HTMLResponse((root / "dist/knowledge-template/frame.html").read_text())


@app.post("/invoke")
async def invoke(request: Request):
    value = await request.json()
    if value["method"] == "files.select":
        return await service.select_files("synthetic", state["session"], ["fixture"])
    if value["method"] == "knowledge.select":
        return await service.select_knowledge("synthetic", state["session"], ["fixture-knowledge"])
    return await service.invoke("synthetic", state["session"], value["method"], value["params"])


uvicorn.run(
    app,
    host="127.0.0.1",
    port=int(os.environ.get("KNOWLEDGE_TEMPLATE_TEST_PORT", "18763")),
    log_level="warning",
)
