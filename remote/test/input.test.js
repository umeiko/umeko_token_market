import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('real Guacamole mouse and touch events forward movement, clicks and wheel with display scaling', () => {
  const context = vm.createContext({ window: {}, navigator: { userAgent: '' } });
  vm.runInContext(readFileSync(new URL('../vendor/guacamole-common.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../web/input.js', import.meta.url), 'utf8'), context);
  const Guacamole = context.Guacamole;
  for (const input of ['mouse', 'touch']) {
    const source = new Guacamole.Mouse.Event.Target();
    const sent = [];
    let focused = 0;
    const cleanup = context.window.UmekoRemoteInput.bindPointer(source, {
      sendMouseState(state, applyScale) { sent.push({ ...state, applyScale }); },
    }, () => focused++);
    source.move({ x: 320, y: 240 });
    source.press('left'); source.release('left');
    source.press('right'); source.release('right');
    source.press('up'); source.release('up');
    assert.equal(sent.length, 7, `${input}: each event must be registered separately`);
    assert.equal(sent[0].x, 320); assert.equal(sent[0].y, 240);
    assert.ok(sent.every((value) => value.applyScale === true));
    assert.equal(sent[1].left, true); assert.equal(sent[2].left, false);
    assert.equal(sent[3].right, true); assert.equal(sent[4].right, false);
    assert.equal(sent[5].up, true); assert.equal(sent[6].up, false);
    assert.equal(focused, 3, 'pressing a button focuses keyboard input');
    cleanup();
    const count = sent.length;
    source.move({ x: 40, y: 50 });
    assert.equal(sent.length, count, 'closed connections must not receive pointer events');
  }
});
