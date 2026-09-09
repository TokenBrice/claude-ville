import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { rewriteEntryKeys } from '../sprites/manifest-utils.mjs';

test('adding an action strip preserves a multiline animation ledger and neighboring entries', () => {
    const source = `characters:
  - id: agent.codex.gpt6astra
    animationGroups:
      walk:
        rows:
          - 0
          - 5
      breathingIdle:
        rows: [6, 9]
    provenance:
      characterId: current-rig
    prompt: "Preserve this exact quoting"
  # Neighbor belongs to another character.
  - id: agent.codex.gpt56luna
    prompt: 'Leave Luna alone'
`;
    const rendered = ['    actionStrip:', '      path: characters/agent.codex.gpt6astra/actions.png', '      cell: 92'];
    const result = rewriteEntryKeys(source, 'agent.codex.gpt6astra', ['actionStrip'], rendered);
    const original = yaml.load(source);
    const updated = yaml.load(result);
    assert.deepEqual(updated.characters[0].animationGroups, original.characters[0].animationGroups);
    assert.deepEqual(updated.characters[0].provenance, original.characters[0].provenance);
    assert.equal(updated.characters[0].actionStrip.cell, 92);
    assert.equal(result.slice(result.indexOf('  # Neighbor')), source.slice(source.indexOf('  # Neighbor')));
    assert.ok(result.includes('    prompt: "Preserve this exact quoting"'));
    assert.equal(rewriteEntryKeys(result, 'agent.codex.gpt6astra', ['actionStrip'], rendered), result);
});
