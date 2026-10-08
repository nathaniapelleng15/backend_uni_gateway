const assert = require('node:assert/strict');
const { test } = require('node:test');
const { corsOrigin } = require('../utils/security');
const packageJson = require('../package.json');

test('backend dev script forces development CORS policy despite production .env', () => {
  assert.match(packageJson.scripts.dev, /NODE_ENV=development/);
});

test('development CORS accepts local Admin and photobooth origins', async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    for (const origin of ['http://localhost:3000', 'http://localhost:3001']) {
      await new Promise((resolve, reject) => corsOrigin(origin, (error, allowed) => {
        if (error) return reject(error);
        try {
          assert.equal(allowed, true);
          resolve();
        } catch (assertionError) { reject(assertionError); }
      }));
    }
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test('production CORS still rejects unconfigured localhost origin', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCors = process.env.CORS_ORIGINS;
  process.env.NODE_ENV = 'production';
  process.env.CORS_ORIGINS = 'https://photobooth.uniinside.net';
  try {
    await new Promise((resolve) => corsOrigin('http://localhost:3000', (error) => {
      assert.match(error?.message || '', /Origin is not allowed by CORS/);
      resolve();
    }));
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalCors === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = originalCors;
  }
});
