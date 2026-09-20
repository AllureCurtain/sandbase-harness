import { describe, expect, it } from 'vitest';
import { PiMarkupBuffer, safePiTextEmitLength, stripPiToolCallMarkup } from '@/strategy/pi/text-markup.js';

describe('Pi structured markup filtering', () => {
  it('removes complete control tokens and structured call blocks', () => {
    expect(stripPiToolCallMarkup('before <|tool_call> after')).toBe('before  after');
    expect(stripPiToolCallMarkup('before call:bash{"command":"ls"}<tool_call|> after')).toBe('before  after');
  });

  it('holds a possible marker prefix across chunks until it is safe', () => {
    const buffer = new PiMarkupBuffer();
    expect(buffer.push('hello res')).toBe('hello ');
    expect(buffer.push('ponse:bash{"command":"ls"}<tool_call|> world')).toBe(' world');
    expect(buffer.flush()).toBe('');
  });

  it('holds control-token prefixes split at chunk boundaries and flushes plain text', () => {
    const buffer = new PiMarkupBuffer();
    expect(buffer.push('value <|tool')).toBe('value ');
    expect(buffer.push('_call> visible')).toBe(' visible');
    expect(buffer.flush()).toBe('');
    expect(safePiTextEmitLength('respons')).toBe(0);
    expect(safePiTextEmitLength('ordinary text')).toBe('ordinary text'.length);
  });

  it('escapes raw HTML text after removing Pi markup', () => {
    expect(stripPiToolCallMarkup('<script>alert("x")</script> & \'quoted\'')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;',
    );
  });
});
