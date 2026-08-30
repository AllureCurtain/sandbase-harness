import { describe, expect, it } from 'vitest';
import { describeModelError } from '@/strategy/default-strategy.js';

describe('describeModelError', () => {
  it('preserves a plain Error with a real message', () => {
    const result = describeModelError(new Error('boom'));
    expect(result.message).toBe('boom');
  });

  it('enriches an Error that carries HTTP status and network cause', () => {
    const err = Object.assign(new Error('provider request failed'), {
      statusCode: 404,
      cause: { code: 'ECONNRESET' },
    });
    const result = describeModelError(err);
    expect(result.message).toContain('provider request failed');
    expect(result.message).toContain('HTTP 404');
    expect(result.message).toContain('ECONNRESET');
  });

  it('reconstructs a message from an AI SDK-style error with an empty message', () => {
    // APICallError-style object whose message is blank but which carries the
    // real detail in statusCode/url/responseBody.
    const err = Object.assign(new Error(''), {
      name: 'AI_APICallError',
      statusCode: 404,
      url: 'https://api.sandbase.ai/chat/completions',
      responseBody: '404 page not found',
    });
    const result = describeModelError(err);
    expect(result.message).not.toBe('');
    expect(result.message).toContain('HTTP 404');
    expect(result.message).toContain('https://api.sandbase.ai/chat/completions');
    expect(result.message).toContain('404 page not found');
  });

  it('handles a non-Error thrown value without collapsing to [object Object]', () => {
    const result = describeModelError({ statusCode: 500, cause: { code: 'ETIMEDOUT' } });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).not.toBe('[object Object]');
    expect(result.message).toContain('HTTP 500');
    expect(result.message).toContain('ETIMEDOUT');
  });

  it('truncates an oversized response body', () => {
    const err = Object.assign(new Error(''), {
      statusCode: 400,
      responseBody: 'x'.repeat(2000),
    });
    const result = describeModelError(err);
    expect(result.message).toContain('…');
    expect(result.message.length).toBeLessThan(700);
  });

  it('redacts a secret carried in the request URL query string', () => {
    const err = Object.assign(new Error(''), {
      statusCode: 401,
      url: 'https://gw.example.com/v1/chat/completions?api_key=super-secret-value-123&x=1',
    });
    const result = describeModelError(err);
    expect(result.message).not.toContain('super-secret-value-123');
    expect(result.message).toContain('api_key=***');
    expect(result.message).toContain('x=1');
  });

  it('redacts bearer tokens and provider key prefixes echoed in the body', () => {
    const err = Object.assign(new Error(''), {
      statusCode: 500,
      responseBody: 'upstream rejected Authorization: Bearer abcDEF1234567890 for key sk-ant-abcd1234efgh',
    });
    const result = describeModelError(err);
    expect(result.message).not.toContain('abcDEF1234567890');
    expect(result.message).not.toContain('sk-ant-abcd1234efgh');
    expect(result.message).toContain('Bearer ***');
    expect(result.message).toContain('sk-***');
  });
});
