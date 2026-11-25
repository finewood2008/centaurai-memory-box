import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { confirmMinutes, createMeeting, finishMeeting, getMeetingRaw, initStore, retryPendingCapture, saveChunk, view } from "../resources/accessory-preview/lib/meetings.mjs";
import { recordingCapture } from "../resources/accessory-preview/lib/library.mjs";

test("confirmed recordings respect their agent switch and retry the same version with its transcript evidence", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "memobox-recording-capture-"));
  const previous = process.env.RECORDING_MODULE_PROFILE;
  const send = process.send;
  t.after(async () => {
    if (previous === undefined) delete process.env.RECORDING_MODULE_PROFILE;
    else process.env.RECORDING_MODULE_PROFILE = previous;
    if (send === undefined) delete process.send;
    else process.send = send;
    await rm(directory, {recursive:true, force:true});
  });
  process.env.RECORDING_MODULE_PROFILE = "accessories";
  await initStore(directory);
  const requests = [];
  let available = false;
  process.send = ({id, payload}, callback) => {
    requests.push(payload);
    callback(null);
    queueMicrotask(() => process.emit("message", {type:"memory-result", id, memoryId:available ? "saved-id" : undefined}));
  };
  const confirm = async source => {
    const {id} = await createMeeting({source, title:"验收录音"});
    const project = getMeetingRaw(id);
    project.state = "finished";
    project.transcript.segments = [{i:0, fromMs:12000, toMs:14000, text:"周五交付。"}];
    project.minutes.document = {sections:[{heading:"决定", blocks:[{text:"周五交付。", quote:"周五交付。", segs:[0]}]}]};
    project.minutes.status = "done";
    project.review.status = "draft";
    return confirmMinutes(id, {documentReview:true});
  };
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({accessoryCapture:{disk:true, clip:true}}));
  assert.deepEqual(await recordingCapture('clip', 'status'), {enabled:false});
  const before = await confirm("clip");
  assert.equal(before.memory.status, "disabled");
  await recordingCapture("clip", "add");
  assert.equal((await confirm("disk")).memory.status, "disabled");
  assert.equal(requests.length, 0);
  const pending = await confirm("clip");
  assert.equal(pending.meeting.review.status, "confirmed");
  assert.equal(pending.memory.status, "pending");
  assert.match(requests[0].content, /#0@00:12/);
  assert.equal(requests[0].kind, "clip");
  assert.equal(requests[0].localOnly, true);
  available = true;
  await recordingCapture("clip", "remove");
  await retryPendingCapture();
  assert.equal(requests.length, 1);
  await recordingCapture("clip", "add");
  await retryPendingCapture();
  await retryPendingCapture();
  assert.equal(requests.length, 1, 'joining again does not replay the revoked queue');
  assert.equal(view(before.meeting.id).memory.status, 'disabled');
  available = false;
  const current = await confirm('clip');
  available = true;
  await retryPendingCapture();
  await retryPendingCapture();
  assert.equal(view(current.meeting.id).savedTo[1].memory.id, "saved-id");
  assert.deepEqual(requests.slice(1).map(p => p.requestId), [requests[1].requestId, requests[1].requestId]);
});

test("a recording finished without a box saves its original audio and defers transcription", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "memobox-recording-audio-only-"));
  t.after(() => rm(directory, {recursive:true, force:true}));
  await initStore(directory);
  const {id} = await createMeeting({source:"disk", title:"断连录音"});
  await saveChunk(id, 0, Buffer.alloc(4800));
  await finishMeeting(id, {chunkCount:1, audioOnly:true});
  for (let attempt = 0; attempt < 100 && view(id).transcript.status !== "offline"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const saved = view(id);
  assert.equal(saved.audio.status, "saved");
  assert(saved.audio.bytes > 44);
  assert.equal(saved.transcript.status, "offline");
  assert.equal(saved.minutes.status, "waiting");
  await initStore(directory);
  assert.equal(view(id).transcript.status, "offline");
});
