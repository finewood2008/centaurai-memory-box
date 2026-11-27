import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const worklet = readFileSync(new URL('../resources/accessory-preview/public/pcm-worklet.js', import.meta.url), 'utf8');

test('a recording bookmark counts original sample frames across pause and includes unflushed audio', () => {
  const messages = [];
  let Processor;
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (message) => messages.push(message) };
    }
  }
  vm.runInNewContext(worklet, {
    AudioWorkletProcessor, sampleRate: 48000,
    registerProcessor: (_name, Constructor) => { Processor = Constructor; },
  });
  const processor = new Processor({ processorOptions: { channels: 2, live: true } });
  const send = (type, id) => processor.port.onmessage({ data: { type, id } });
  const frames = (count) => processor.process([[new Float32Array(count), new Float32Array(count)]]);
  const bookmarks = () => messages.filter((message) => message.type === 'bookmark').map(({ id, sampleOffset }) => [id, sampleOffset]);

  frames(480);
  send('bookmark', 1);
  assert.equal(messages.some((message) => message.type === 'chunk'), false);
  send('pause');
  frames(960);
  send('bookmark', 2);
  send('resume');
  frames(240);
  send('bookmark', 3);
  send('flush', 4);

  assert.deepEqual(bookmarks(), [[1, 480], [2, 480], [3, 720]]);
  const savedFrames = messages.filter((message) => message.type === 'chunk').reduce((total, { pcm }) => total + pcm.byteLength / 4, 0);
  assert.equal(savedFrames, 720);
});
