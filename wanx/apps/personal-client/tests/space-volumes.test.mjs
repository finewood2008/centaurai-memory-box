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
  inventory = [{id:"usb-a",name:"工作硬盘"}]; await poll();
  assert.match(view.view(), /工作硬盘/);
  assert.match(view.view(), /测试.txt/);
  const pending = view.action("file", "测试.txt");
  inventory = []; await poll();
  finishPreview({ok:true,value:{text:"old content"}}); await pending;
  assert.equal(view.active(), false); assert.equal(view.sidebar(),"");
  view.watch(null);
});

test("a link from the manager waits for the new Space inventory and abandons the old box's reply", async () => {
  let finish;
  const window = {wanxClient: {action(name, {op}) {
    if (op === "volumes") return new Promise(resolve => {finish = resolve;});
    return Promise.resolve({ok:true, value:{items:[],total:0,pageSize:100}});
  }}};
  const source = await readFile(new URL("../local-ui/renderer/space-volumes.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {window, setTimeout: () => 1, clearTimeout(){}});
  const view = window.createSpaceVolumes({render(){}, esc:String, icon:()=>"", fileIcon:()=>"", size:String});
  const result = {ok:true,value:[{id:"usb-a",name:"工作硬盘"}]};
  view.watch("79");
  const gone = view.showUnavailable("usb-a"), old = finish;
  view.watch("78");
  old(result); await gone;
  assert.equal(view.active(), false);
  const current = view.showUnavailable("usb-a");
  finish(result); await current;
  assert.equal(view.active(), true);
  assert.match(view.view(), /外接硬盘暂无法进入文件管理/);
});

test("the desktop preload forwards the manager's navigation to Space and Accessories", async () => {
  const source = await readFile(new URL("../local-ui/remote-preload.cjs", import.meta.url), "utf8");
  const exposed = {}, listeners = new Map(), destinations = [];
  vm.runInNewContext(source, {
    process: {platform:"darwin"},
    require: () => ({
      contextBridge: {exposeInMainWorld: (name, value) => {exposed[name] = value;}},
      ipcRenderer: {on: (channel, listener) => listeners.set(channel, listener)},
    }),
  });
  exposed.wanxClient.onNavigate(page => destinations.push(typeof page === "string" ? page : {...page}));
  const navigate = listeners.get("wanx-client:navigate");
  navigate({}, {destination:"space-volume", volume:"photos@8-2", extra:"ignored"});
  navigate({}, {destination:"space-volume", volume:""});
  navigate({}, {destination:"space-volume", volume:"\u202e"});
  navigate({}, {destination:"space-volume", volume:"x".repeat(257)});
  navigate({}, {destination:"space-volume", volume:2});
  navigate({}, "accessories");
  assert.deepEqual(destinations, [{destination:"space-volume", volume:"photos@8-2"}, "accessories"]);
});
