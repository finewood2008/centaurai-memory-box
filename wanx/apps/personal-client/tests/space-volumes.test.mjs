import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("volume polling follows insertion, navigation, removal and late replies", async () => {
  let inventory = [], poll, finishPreview;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const window = {wanxClient: {async action(name, {op, volume, path}) {
    assert.equal(name, "space-volumes");
    if (op === "volumes") return {ok:true, value:inventory};
    assert.equal(volume, "usb-a");
    if (op === "preview") return new Promise(resolve => { finishPreview = resolve; });
    return {ok:true, value:{items:path ? [{name:"测试.txt",folder:false,size:8}] : [{name:"照片",folder:true}], total:1, pageSize:100}};
  }}};
  const source = await readFile(new URL("../local-ui/renderer/space-volumes.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {window, setTimeout: fn => {poll=fn;}, clearTimeout(){}});
  const view = window.createSpaceVolumes({render(){}, esc:String, icon:()=>"", fileIcon:()=>"", size:String});
  view.watch("79"); await tick();
  assert.equal(view.sidebar(), "");
  inventory = [{id:"usb-a",name:"CentaurAI"}]; await poll();
  assert.match(view.sidebar(), /CentaurAI/);
  await view.action("select", "usb-a"); assert.match(view.view(), /照片/);
  await view.action("child", "照片"); assert.match(view.view(), /测试.txt/);
  const pending = view.action("file", "测试.txt");
  inventory = []; await poll();
  finishPreview({ok:true,value:{text:"old content"}}); await pending;
  assert.equal(view.active(), false); assert.equal(view.sidebar(),"");
  view.watch(null);
});
