import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { patchStatusSource, networkSourceDigest } from "../tools/netbird-status-build.mjs";
const run = promisify(execFile);
// The SDK's exact Status implementation, exercised with a deliberately blocked
// control-plane probe and a live recorder. No networking or customer state.
const status = `func (c *Client) Status() (peer.FullStatus, error) {
 c.mu.Lock()
 connect := c.connect
 c.mu.Unlock()
 if connect != nil {
  engine := connect.Engine()
  if engine != nil {
   _ = engine.RunHealthProbes(context.Background(), false)
  }
 }
 return c.recorder.GetFullStatus(), nil
}`;
test("status reads remain fresh and immediate while one remote probe is blocked", async () => {
 const directory = await mkdtemp(path.join(tmpdir(), "wanx-status-test-"));
 try {
  const source = `package status
import("context";"sync";"sync/atomic";"testing";"time")
 type Client struct { mu sync.Mutex; connect *connection; recorder *recorder }
 type connection struct { engine *engine }; func(c *connection) Engine()*engine{return c.engine}
 type engine struct { calls atomic.Int32; entered chan struct{}; release chan struct{} }
 func(e *engine) RunHealthProbes(context.Context,bool)bool { if e.calls.Add(1)==1 {close(e.entered)}; <-e.release; return true }
 type fullStatus struct { Connected bool }; type recorder struct { connected atomic.Bool }
 func(r *recorder) GetFullStatus()fullStatus {return fullStatus{r.connected.Load()}}
 ${status}
 func TestStatus(t *testing.T){
 e:= &engine{entered:make(chan struct{}),release:make(chan struct{})}; defer close(e.release)
 r:= &recorder{}; r.connected.Store(true); c:= &Client{connect:&connection{e},recorder:r}
 done:=make(chan fullStatus,1); go func(){s,_:=c.Status();done<-s}()
 select {case s:=<-done: if !s.Connected {t.Fatal("lost current peer")}; case <-time.After(100*time.Millisecond): t.Fatal("status blocked on external health probe")}
 <-e.entered
 for range 20 {s,_:=c.Status();if !s.Connected {t.Fatal("false offline during blocked probe")}}
 r.connected.Store(false); s,_:=c.Status();if s.Connected {t.Fatal("masked real peer disconnect")}
 if e.calls.Load()!=1 {t.Fatal("concurrent remote probes",e.calls.Load())}
 }
 `;
  await writeFile(path.join(directory, "go.mod"), "module statusfixture\ngo 1.26\n");
  await writeFile(path.join(directory, "status_test.go"), patchStatusSource(source).replaceAll("peer.FullStatus", "fullStatus"));
  const options = {cwd:directory};
  const {stdout: cgo} = await run("go", ["env", "CGO_ENABLED"], options);
  // Always test the blocked-probe behavior; use the race detector where Go has a C toolchain.
  const flags = cgo.trim() === "1" ? ["-race"] : [];
  const result=await run("go",["test","-trimpath",...flags,"-timeout=15s","."],options);
  assert.match(result.stdout,/ok/);
 } finally {await rm(directory,{recursive:true,force:true});}
});
test("SDK signature drift fails the build instead of silently restoring blocking reads",()=> {
 assert.throws(()=>patchStatusSource("package embed"),/Unsupported NetBird/);
});

test("native source fingerprints invalidate old engines without hashing generated binaries", async () => {
 const root=await mkdtemp(path.join(tmpdir(),"wanx-network-digest-"));
 try {
  for(const directory of ["native/cmd/wanx-netbird","native/bin","tools"]) await mkdir(path.join(root,directory),{recursive:true});
  for(const file of ["native/go.mod","native/go.sum","tools/build-network.mjs","native/cmd/wanx-netbird/main.go"]) await writeFile(path.join(root,file),file);
  const first=await networkSourceDigest(root);
  await writeFile(path.join(root,"native/bin/engine"),"generated");
  assert.equal(await networkSourceDigest(root),first);
  await writeFile(path.join(root,"native/cmd/wanx-netbird/main.go"),"changed SDK adapter");
  assert.notEqual(await networkSourceDigest(root),first);
 } finally {await rm(root,{recursive:true,force:true});}
});
