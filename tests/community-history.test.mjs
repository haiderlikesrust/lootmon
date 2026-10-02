import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommunityHistory } from '../server/community-history.mjs';
import { Community } from '../server/community.mjs';
import { Game } from '../server/game.mjs';

test('chat, opening notices and activity survive restart in the same CA only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lootmon-community-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = join(root, 'coin-one', 'game-state.json');
  await mkdir(join(root, 'coin-one'));
  const history = new CommunityHistory(world);
  const game = new Game();
  game.addPlayer('hunter', 'Hunter', Date.now(), { wallet: 'hunter', eligible: true });
  const community = new Community(game, { onChange: snapshot => history.save(snapshot) });
  community.packEvent({ kind: 'opening', id: 'order', tier: 25 });
  community.packEvent({ kind: 'opened', id: 'order', tier: 25, name: 'Card', insuredValue: 17 });
  assert.equal(community.submit('hunter', 'See you after the restart!').ok, true);
  const expected = community.snapshot();
  await history.flush();
  community.close();
  const restored = new Community(game, { history: new CommunityHistory(world).load() });
  assert.deepEqual(restored.snapshot(), expected);
  restored.packEvent({ kind: 'opened', id: 'order', tier: 25, name: 'Card', insuredValue: 17 });
  assert.deepEqual(restored.snapshot(), expected, 'replayed provider notices are deduplicated');
  assert.equal(new CommunityHistory(join(root, 'coin-two', 'game-state.json')).load(), null);
  restored.close();
});

test('rapid saves serialize and retain the latest bounded snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lootmon-community-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = new CommunityHistory(join(root, 'game-state.json'));
  const writes = Array.from({ length: 100 }, (_, index) => history.save({ chat: [{ text: String(index) }], activity: [] }));
  await Promise.all(writes); await history.flush();
  assert.equal(history.load().chat[0].text, '99');
  await history.save({ chat: [{ text: 'later' }], activity: [] });
  assert.equal(history.load().chat[0].text, 'later');
});

test('malformed history is preserved rather than silently erased', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lootmon-community-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = new CommunityHistory(join(root, 'game-state.json'));
  await writeFile(history.path, '{broken');
  assert.throws(() => history.load());
  assert.equal(await readFile(history.path, 'utf8'), '{broken');
});
