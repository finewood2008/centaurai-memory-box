import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTOML, getStaticTOMLValue } from "toml-eslint-parser";
import { createCodexModelConfig } from "../shell/my-ai-codex-model-config.mjs";

const route={base:"http://127.0.0.1:44444/v1",helper:"/tmp/with space/credential",catalog:"/tmp/with space/models.json",model:"cloud-flash"};
function fixture(t,initial) {
  const directory=mkdtempSync(path.join(tmpdir(),"codex-model-switch-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,"config.toml"), journal=path.join(directory,"recover.json");
  if(initial!==null)writeFileSync(file,initial,{mode:0o600});
  return {file,journal,config:createCodexModelConfig({file,journal})};
}

for(const original of [null,"","# original only","model = 'first'  # comment\r\n[projects.\"/space name\"]\r\ntrust_level = 'trusted'\r\n",
  "# original\n'model_provider'='company' # custom\nmodel_catalog_json = '/etc/models.json'\n[model_providers.company]\nname='Company'\n"]) {
  test("restores exact Codex settings, including a previously absent config: "+JSON.stringify(original),t=>{
    const {file,journal,config}=fixture(t,original);
    config.apply(route);
    const value=getStaticTOMLValue(parseTOML(readFileSync(file,"utf8")));
    assert.equal(value.model,route.model);
    assert.equal(value.model_providers[value.model_provider].auth.command,route.helper);
    assert.equal(value.model_catalog_json,route.catalog);
    createCodexModelConfig({file,journal}).restore(); // a fresh client after interruption
    assert.equal(existsSync(file)?readFileSync(file,"utf8"):null,original);
    assert.equal(existsSync(journal),false);
  });
}
test("preserves independent edits and refuses to overwrite a changed model",t=>{
  const {file,config}=fixture(t,"model='old'\n[features]\nexample=false\n");
  config.apply(route);
  writeFileSync(file,readFileSync(file,"utf8").replace("example=false","example=true"));
  config.apply({...route,model:"next"});
  config.restore();
  assert.equal(readFileSync(file,"utf8"),"model='old'\n[features]\nexample=true\n");
  config.apply(route);
  const external=readFileSync(file,"utf8").replace('"cloud-flash"', '"user-choice"');
  writeFileSync(file,external);
  assert.throws(()=>config.restore());
  assert.equal(readFileSync(file,"utf8"),external);
  assert.ok(config.pending());
});
test("rejects a conflicting provider or invalid TOML without modifying the config",t=>{
  for (const original of ["[model_providers.memobox_cloud_desktop]\nname='mine'\n",'[invalid']) {
    const {file,config}=fixture(t,original);
    assert.throws(()=>config.apply(route));
    assert.equal(readFileSync(file,"utf8"),original);
    assert.equal(config.pending(),false);
  }
});

test("allows Codex to reformat its managed table and retains unrelated settings",t=>{
  const {file,config}=fixture(t,"model='old'\n[features]\nexample=false\n");
  config.apply(route);
  writeFileSync(file,readFileSync(file,"utf8").replace('name = "MemoBox Cloud"', "name='MemoBox Cloud'").replace("example=false","example=true"));
  config.restore();
  assert.deepEqual(getStaticTOMLValue(parseTOML(readFileSync(file,"utf8"))),{model:"old",features:{example:true}});
});

test("Windows credential interpreter and arguments survive TOML configuration and restore", t => {
  const {file,config}=fixture(t,null);
  const helperCommand="C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const helperArgs=["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File","C:\\Users\\测试 空格\\credential.ps1"];
  config.apply({...route,helperCommand,helperArgs});
  const value=getStaticTOMLValue(parseTOML(readFileSync(file,"utf8")));
  assert.equal(value.model_providers[value.model_provider].auth.command,helperCommand);
  assert.deepEqual(value.model_providers[value.model_provider].auth.args,helperArgs);
  config.restore();
  assert.equal(existsSync(file),false);
});
