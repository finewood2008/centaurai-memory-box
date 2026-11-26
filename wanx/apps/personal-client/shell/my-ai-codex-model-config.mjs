import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";

const provider = "memobox_cloud_desktop";
const digest = text => createHash("sha256").update(text ?? "").digest("hex");
const conflict = () => new Error("Codex 的模型配置已被其他程序修改。已保留现场，请先检查模型配置再切换。");

function read(file) {
  const stat = lstatSync(file,{throwIfNoEntry:false});
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error("无法安全编辑此 Codex 配置文件。");
  return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(readFileSync(file));
}

function replace(file, expected, next) {
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp = file+"."+randomUUID()+".tmp";
  try {
    if (next !== null) {
      const mode = lstatSync(file,{throwIfNoEntry:false})?.mode ?? 0o600;
      writeFileSync(temp,next,{flag:"wx",mode:0o600,flush:true});
      chmodSync(temp,mode & 0o777);
    }
    if (read(file) !== expected) throw conflict();
    if (next === null) rmSync(file,{force:true});
    else renameSync(temp,file);
  } finally { rmSync(temp,{force:true}); }
}

function document(text) {
  try { return parseTOML(text).body[0].body; }
  catch { throw new Error("Codex 配置不是可编辑的 TOML，原文件已保留。"); }
}
const key = node => node.key.keys.map(part=>part.name ?? part.value);
const setting = (nodes,name) => nodes.find(n => n.type === "TOMLKeyValue" && key(n).length === 1 && key(n)[0] === name);
const splice = (text,[start,end],value) => text.slice(0,start)+value+text.slice(end);

function prepare(text, {base,helper,model,catalog}) {
  const nodes = document(text);
  if (setting(nodes,"profile")) throw new Error("Codex 当前使用具名配置档。请先在 Codex 选回默认配置档，再使用自动切换。");
  const values = {model,model_provider:provider,model_catalog_json:catalog};
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let edited=text, added="";
  const original = {};
  const replacements=[];
  for (const [name,value] of Object.entries(values)) {
    const entry=setting(nodes,name);
    original[name]=entry ? text.slice(...entry.value.range) : null;
    if (entry) replacements.push({range:entry.value.range,value:JSON.stringify(value)});
    else added += name+" = "+JSON.stringify(value)+newline;
  }
  for (const edit of replacements.sort((a,b)=>b.range[0]-a.range[0])) edited=splice(edited,edit.range,edit.value);
  const block = ["", "[model_providers."+provider+"]", 'name = "MemoBox Cloud"', "base_url = "+JSON.stringify(base),
    'wire_api = "responses"', "supports_websockets = false", "requires_openai_auth = false",
    "auth = { command = "+JSON.stringify(helper)+", refresh_interval_ms = 1000 }",""].join(newline);
  // Parsing again detects conflicts with existing user-owned provider definitions.
  const next = added+edited+block;
  document(next);
  return {next, original, values, block};
}

function undo(text,state) {
  const index=text.indexOf(state.block);
  let next;
  if (index >= 0 && index === text.lastIndexOf(state.block)) {
    next=splice(text,[index,index+state.block.length],"");
  } else {
    // Codex can reformat provider tables, including expanding the inline auth table.
    const expected=getStaticTOMLValue(parseTOML(state.block)).model_providers[provider];
    const actual=getStaticTOMLValue(parseTOML(text)).model_providers?.[provider];
    if (!isDeepStrictEqual(actual,expected)) throw conflict();
    const tables=document(text).filter(n=>n.type==="TOMLTable" && n.resolvedKey[0]==="model_providers" && n.resolvedKey[1]===provider);
    if (!tables.length) throw conflict();
    next=text;
    for (const table of tables.reverse()) next=splice(next,table.range,"");
  }
  const nodes=document(next), edits=[];
  for (const [name,value] of Object.entries(state.values)) {
    const entry=setting(nodes,name);
    if (!entry || entry.value.value !== value) throw conflict();
    if (state.original[name] !== null) edits.push({range:entry.value.range,value:state.original[name]});
    else {
      const [start,end]=entry.range;
      const tail=/^[ \t]*(?:\r\n|\n|$)/.exec(next.slice(end));
      if (!tail) throw conflict();
      edits.push({range:[start,end+tail[0].length],value:""});
    }
  }
  for (const edit of edits.sort((a,b)=>b.range[0]-a.range[0])) next=splice(next,edit.range,edit.value);
  document(next);
  return next;
}

export function createCodexModelConfig({file,journal}) {
  function restore() {
    const saved=read(journal);
    if (!saved) return false;
    const state=JSON.parse(saved), current=read(file);
    // The write-ahead record also covers an interruption on either side of the config rename.
    if (current !== null && digest(current) !== state.before) {
      const original=undo(current,state);
      replace(file,current,state.absent && original === "" ? null : original);
    } else if (current === null && !state.absent) throw conflict();
    replace(journal,saved,null);
    return true;
  }
  return {
    pending:()=>Boolean(lstatSync(journal,{throwIfNoEntry:false})),
    apply(route) {
      restore();
      const current=read(file);
      const {next,...patch}=prepare(current ?? "",route);
      const record=JSON.stringify({...patch,absent:current===null,before:digest(current)});
      replace(journal,null,record);
      try { replace(file,current,next); }
      catch(error) { replace(journal,record,null); throw error; }
    },
    restore,
  };
}
