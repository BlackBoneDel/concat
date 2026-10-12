// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/** Effects/text edits: undoable, exact inverses. */

import { describe, expect, it } from 'vitest';
import { SetClipEffectsOperation, SetClipTextOperation, clipEffectsOf, updateClipEffects } from '../src/editor/effect-operations.ts';
import { emptyClipEffects } from '../src/media/clip-effects.ts';
import { DEFAULT_CHROMA_KEY } from '../src/media/vision/chroma-key.ts';
import { blankClip, defaultTextStyle } from '../src/model/document.ts';
import { clipById, makeSession, snap } from './f3-helpers.ts';

describe('SetClipEffectsOperation', () => {
  it('stores effects in clip.extra.effects and undoes to the identical document', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const before = snap(session.document);
    expect(session.run(updateClipEffects(session.document, 'c1', (fx) => {
      fx.chromaKey = { ...DEFAULT_CHROMA_KEY };
      fx.lut = { id: 'builtin:warm', strength: 0.6 };
    }))).toBe(true);
    expect(clipEffectsOf(session.document, 'c1').lut).toEqual({ id: 'builtin:warm', strength: 0.6 });
    expect(clipById(session, 'c1').extra['effects']).toMatchObject({ version: 1 });
    const middle = snap(session.document);
    expect(session.run(updateClipEffects(session.document, 'c1', (fx) => { fx.lut = null; }))).toBe(true);
    expect(clipEffectsOf(session.document, 'c1').lut).toBeNull();
    session.undo();
    expect(snap(session.document)).toBe(middle);
    // Clearing every effect removes the key.
    expect(session.run(new SetClipEffectsOperation('c1', emptyClipEffects()))).toBe(true);
    expect('effects' in clipById(session, 'c1').extra).toBe(false);
    session.undo();
    session.undo();
    expect(snap(session.document)).toBe(before);
    expect(session.run(new SetClipEffectsOperation('nope', null))).toBe(false);
  });
});

describe('SetClipTextOperation', () => {
  it('edits text clips only, with exact undo', () => {
    const session = makeSession([{ start: 0, duration: 2 }]);
    const text = blankClip('t1', 'T1', 'text', 'Título', 3, 1);
    text.text = { ...defaultTextStyle(), content: 'Hola' };
    session.document.timelines[0]!.clips.push(text);
    session.history.rebase(session.document);
    const before = snap(session.document);
    expect(session.run(new SetClipTextOperation('t1', { ...defaultTextStyle(), content: 'Adiós', italic: true }))).toBe(true);
    expect(clipById(session, 't1').text).toMatchObject({ content: 'Adiós', italic: true });
    session.undo();
    expect(snap(session.document)).toBe(before);
    expect(session.run(new SetClipTextOperation('c1', defaultTextStyle()))).toBe(false);
  });
});
