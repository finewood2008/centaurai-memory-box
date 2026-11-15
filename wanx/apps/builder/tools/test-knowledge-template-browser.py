"""Run against knowledge-template-preview.py; never uses a real WANX account."""

import json
import os
from pathlib import Path

from playwright.sync_api import Locator, expect, sync_playwright

_native_click = Locator.click


def centered_click(self, *args, **kwargs):
    self.evaluate('e=>e.scrollIntoView({block:"center",inline:"center"})')
    return _native_click(self, *args, **kwargs)


Locator.click = centered_click
out = Path(__file__).resolve().parents[2] / "verification/knowledge-template"
out.mkdir(parents=True, exist_ok=True)
expect.set_options(timeout=30000)
checks = []


def mark(text):
    checks.append(text)
    print(text, flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    page.set_default_timeout(30000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://127.0.0.1:" + os.environ.get("KNOWLEDGE_TEMPLATE_TEST_PORT", "18763") + "/")
    f = page.frame_locator("iframe")
    expect(f.get_by_role("heading", name="把资料变成有依据的回答")).to_be_visible(timeout=30000)
    page.screenshot(path=str(out / "01-overview-empty.png"))
    mark("真实沙箱启动与空副本")
    f.get_by_role("button", name="设置与记录", exact=True).click()
    f.get_by_role("button", name="保存为新版本", exact=True).click()
    expect(f.get_by_text("修改配置", exact=False).first).to_be_visible(timeout=30000)
    mark("配置保存")
    f.get_by_role("button", name="资料", exact=True).click()
    f.get_by_role("button", name="选择空间资料", exact=True).click()
    expect(f.get_by_role("heading", name="合成培训说明.txt")).to_be_visible()
    expect(f.get_by_text("草稿", exact=True)).to_be_visible()
    f.get_by_role("button", name="确认发布", exact=True).click()
    f.locator(".overlay input").fill("确认")
    f.get_by_role("button", name="确认保存", exact=True).click()
    expect(f.get_by_text("已发布", exact=True)).to_be_visible()
    mark("受控资料选择、草稿、人工发布")
    f.get_by_role("button", name="问答与会话", exact=True).click()
    f.get_by_role("textbox", name="输入问题").fill("申请培训证明")
    f.get_by_role("button", name="发送问题", exact=True).click()
    expect(f.locator(".answer .answer-text")).to_contain_text("学习中心", timeout=15000)
    f.get_by_text("[1] 合成培训说明.txt · 片段 1", exact=True).click()
    page.screenshot(path=str(out / "02-answer-evidence.png"))
    mark("模拟模型回答、引用、实际持久会话")
    f.get_by_role("textbox", name="输入问题").fill("火星停车条例")
    f.get_by_role("button", name="发送问题", exact=True).click()
    expect(f.locator(".answer .answer-text")).to_contain_text("已记录为待人工处理")
    f.get_by_role("button", name="人工处理", exact=True).click()
    f.get_by_role("button", name="填写人工答复", exact=True).click()
    f.get_by_role("textbox", name="答复（保存后自动进入口径待审核）").fill(
        "合成人工口径：请联系行政负责人。"
    )
    f.get_by_role("button", name="确认保存", exact=True).click()
    expect(f.get_by_text("已答复", exact=True)).to_be_visible()
    f.get_by_role("button", name="口径库", exact=True).click()
    expect(f.get_by_text("草稿", exact=True)).to_be_visible()
    f.get_by_role("button", name="审核发布", exact=True).click()
    f.locator(".overlay input").fill("确认")
    f.get_by_role("button", name="确认保存", exact=True).click()
    expect(f.get_by_text("已发布", exact=True)).to_be_visible()
    mark("无依据人工处理→答复草稿→人工发布")
    f.get_by_role("button", name="问答与会话", exact=True).click()
    f.get_by_role("textbox", name="输入问题").fill("火星停车条例")
    f.get_by_role("button", name="发送问题", exact=True).click()
    expect(f.locator(".answer .answer-text")).to_have_text("合成人工口径：请联系行政负责人。")
    mark("新发布口径精确原文回答")
    f.get_by_role("button", name="回归测试", exact=True).click()
    for question, expected in [("申请培训证明", "answer"), ("星云饲养规则", "handoff")]:
        f.get_by_role("button", name="添加测试题", exact=True).click()
        f.locator(".overlay").get_by_role("textbox", name="问题", exact=True).fill(question)
        f.locator(".overlay").get_by_label("预期结果", exact=True).select_option(expected)
        f.get_by_role("button", name="确认保存", exact=True).click()
        expect(f.locator(".overlay")).to_have_count(0)
    f.get_by_role("button", name="运行回归", exact=True).click()
    expect(f.locator(".result-row")).to_have_count(2, timeout=20000)
    for score in f.locator(".result-row input").all():
        score.fill("1")
    f.get_by_role("button", name="确认并保存逐题评分", exact=True).click()
    expect(f.get_by_text("已评分", exact=True)).to_be_visible()
    page.screenshot(path=str(out / "03-regression.png"))
    mark("回归试答与逐题人工评分")
    f.get_by_role("button", name="概览", exact=True).click()
    f.get_by_role("button", name="开放网页问答", exact=True).click()
    expect(f.get_by_text("已开放网页问答", exact=True)).to_be_visible()
    page.screenshot(path=str(out / "04-overview-ready.png"))
    mark("验收开放门槛")
    page.reload()
    expect(f.get_by_text("已开放网页问答", exact=True)).to_be_visible(timeout=15000)
    mark("重新打开后数据保留")
    for width in [1440, 1000, 768, 390]:
        page.set_viewport_size({"width": width, "height": 1000})
        box = page.frames[1].evaluate(
            "({width:innerWidth,scroll:document.documentElement.scrollWidth})"
        )
        assert box["scroll"] <= box["width"], box
    page.screenshot(path=str(out / "05-mobile.png"))
    mark("四种视口无页面横向溢出")
    assert not errors, errors
    browser.close()
(out / "browser-results.json").write_text(
    json.dumps(
        {
            "checks": checks,
            "page_errors": errors,
            "runtime": "actual PersonalWorkshop / SQLite / compiler / sandbox; model & selected file are synthetic",
        },
        ensure_ascii=False,
        indent=2,
    )
)
print(json.dumps({"passed": len(checks), "checks": checks}, ensure_ascii=False))
