import { describe, expect, it } from 'vitest';
import { PiJsonlProtocolError, readPiJsonl } from '@/strategy/pi/jsonl-reader.js';

async function collect(stream: AsyncIterable<Uint8Array | string>, max = 16 * 1024 * 1024) {
  const lines: string[] = [];
  for await (const line of readPiJsonl(stream, max)) lines.push(line);
  return lines;
}

async function* chunks(values: Array<Uint8Array | string>) {
  for (const value of values) yield value;
}

describe('Pi JSONL reader', () => {
  it('frames LF-delimited lines across arbitrary UTF-8 chunks without readline', async () => {
    const bytes = Buffer.from('{"type":"message_update","text":"你好"}\n{"type":"turn_end"}\n', 'utf8');
    const split = bytes.indexOf(Buffer.from('好', 'utf8')) + 1;
    const lines = await collect(chunks([
      bytes.subarray(0, 7),
      bytes.subarray(7, split),
      bytes.subarray(split, split + 1),
      bytes.subarray(split + 1),
    ]));

    expect(lines).toEqual([
      '{"type":"message_update","text":"你好"}',
      '{"type":"turn_end"}',
    ]);
  });

  it('accepts CRLF and a final line without LF while skipping empty lines', async () => {
    await expect(collect(chunks(['\r\n', '{"type":"session"}\r\n', '\n', '{"type":"agent_end"}']))).resolves.toEqual([
      '{"type":"session"}',
      '{"type":"agent_end"}',
    ]);
  });

  it('rejects an oversized incomplete line before buffering beyond the limit', async () => {
    await expect(collect(chunks(['1234']), 3)).rejects.toMatchObject({
      name: 'PiJsonlProtocolError',
      code: 'pi_jsonl_protocol_error',
    } satisfies Partial<PiJsonlProtocolError>);
  });

  it('rejects an oversized completed line and invalid UTF-8', async () => {
    await expect(collect(chunks(['12345\n']), 4)).rejects.toThrow('exceeds 4 bytes');
    await expect(collect(chunks([new Uint8Array([0xc3, 0x28, 0x0a])]))).rejects.toThrow('valid UTF-8');
  });
});
