import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Miniflare } from 'miniflare';

describe('Porto Tech News Worker', () => {
  let mf;

  beforeAll(async () => {
    // Create a new Miniflare instance
    mf = new Miniflare({
      modules: true,
      scriptPath: './src/index.js',
      kvNamespaces: ['SEEN_ARTICLES', 'REPORTS'],
      bindings: {
        // Mock environment variables
        EMAIL_API_KEY: 'test-api-key',
        GPT4ALL_ENDPOINT: 'http://localhost:4891/v1/completions',
        EMAIL_FROM: 'test@example.com',
        EMAIL_TO: 'recipient@example.com'
      }
    });
  });

  it('should return a health check response', async () => {
    const res = await mf.dispatchFetch('http://localhost/');
    expect(res.status).toBe(200);
    
    const body = await res.json();
    expect(body.status).toBe('Porto Tech News service is running');
    expect(body.timestamp).toBeDefined();
  });

  it('should accept a request to run the report', async () => {
    const res = await mf.dispatchFetch('http://localhost/run-report', {
      method: 'POST'
    });
    expect(res.status).toBe(200);
    
    const body = await res.json();
    expect(body.status).toBe('Report generation started');
    expect(body.timestamp).toBeDefined();
  });

  it('should return 404 for unknown routes', async () => {
    const res = await mf.dispatchFetch('http://localhost/unknown-route');
    expect(res.status).toBe(404);
  });
}); 