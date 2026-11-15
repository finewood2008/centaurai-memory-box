import test from 'node:test';
import assert from 'node:assert/strict';
import {mainWindowBounds} from '../shell/window-layout.mjs';
test('large displays open a centered 1100 by 760 main window',()=>{
 assert.deepEqual(mainWindowBounds({x:0,y:0,width:2560,height:1440}),{x:730,y:340,width:1100,height:760,minWidth:760,minHeight:560});
});
test('small work areas retain margins and achievable resize limits',()=>{
 const b=mainWindowBounds({x:0,y:0,width:600,height:400});assert.equal(b.width,540);assert.equal(b.height,360);assert.equal(b.minWidth,540);assert.equal(b.minHeight,360);
});
test('a negative-coordinate display keeps its window within that display',()=>{
 const a={x:-1920,y:-100,width:1920,height:1080},b=mainWindowBounds(a);assert.ok(b.x>=a.x&&b.y>=a.y);assert.ok(b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height);
});
test('invalid work areas cannot produce unusable window bounds',()=>{
 for(const a of [null,{}, {x:0,y:0,width:0,height:500},{x:NaN,y:0,width:800,height:600}])assert.throws(()=>mainWindowBounds(a),TypeError);
});
