const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function load(file, deps) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(path.join(root, file)),
    require: name => { assert.ok(name in deps, `unexpected dependency ${name}`); return deps[name]; }, console
  });
  return module.exports;
}
const response = () => ({ statusCode: 200, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; return this; }, send(html) { this.html=html; return this; } });
function uploadHarness(packageType = 'digital_print') {
  const stored = [], moves = [];
  const controller = load('controllers/photoController.js', {
    '../models/photoModel': { create: async photo => stored.push(photo) },
    '../models/sessionModel': { findByCodeAndKiosk: async () => ({ payment_status: 'verified', package_type: packageType }) },
    '../utils/imageValidation': { assertImageFile: async () => {} },
    'path': path,
    'fs/promises': { unlink: async () => {}, mkdir: async () => {}, rename: async (...args) => moves.push(args) }
  });
  return { controller, stored, moves };
}
test('print-purpose upload is stored separately with session ownership, digital upload unchanged', async () => {
  const h = uploadHarness();
  const req = purpose => ({ file: {filename:'unique.png',path:'/uploads/unique.png'}, params:{session_code:'S'},body:{purpose},kiosk:{id:'K'} });
  let res = response(); await h.controller.uploadPhoto(req('print'), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.url, '/uploads/print/unique.png');
  assert.equal(h.moves.length, 1);
  assert.equal(h.stored[0].session_id, 'S');
  res = response(); await h.controller.uploadPhoto(req(undefined), res);
  assert.equal(res.body.url, '/uploads/unique.png');
  assert.equal(h.moves.length, 1);
});
test('digital-only sessions cannot upload a print-purpose asset', async () => {
  const h = uploadHarness('digital');
  const res = response();
  await h.controller.uploadPhoto({ file:{filename:'x.png',path:'/uploads/x.png'},params:{session_code:'S'},body:{purpose:'print'},kiosk:{id:'K'} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(h.stored.length, 0);
});
test('download gallery excludes print derivatives and keeps full grid as final digital image', async () => {
  const queries = [];
  const controller = load('controllers/downloadController.js', {
    '../config/db': { query: async sql => {
      queries.push(sql);
      if (sql.includes('FROM sessions')) return [[{session_code:'S'}]];
      const photos = [{url:'/uploads/raw.png'}, {url:'/uploads/grid.png'}, {url:'/uploads/print/crop.png'}];
      return [sql.includes("url NOT LIKE '/uploads/print/%'") ? photos.slice(0,2) : photos];
    } },
    '../utils/security': { publicBaseUrl: () => 'https://cdn' }
  });
  const res = response();
  await controller.serveDownloadPage({params:{session_code:'S'}}, res);
  assert.match(res.html, /https:\/\/cdn\/uploads\/grid.png/);
  assert.doesNotMatch(res.html, /print\/crop.png/);
  assert.match(queries[1], /url NOT LIKE '\/uploads\/print\/%'/);
});
