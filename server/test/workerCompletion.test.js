const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Job = require('../src/models/Job');
const Batch = require('../src/models/Batch');
const mediaQueue = require('../src/queues/mediaQueue');

test('worker commits the moved file only while the job is active', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-completion-'));
  const previousDir = process.env.DOWNLOADS_DIR;
  process.env.DOWNLOADS_DIR = dir;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.DOWNLOADS_DIR;
    else process.env.DOWNLOADS_DIR = previousDir;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { processJob } = require('../src/worker');
  t.mock.method(fs, 'statfs', async () => ({ bavail: 1e9, bsize: 4096 }));
  t.mock.method(mediaQueue, 'setJobProgressCache', async () => {});
  t.mock.method(mediaQueue, 'clearJobProgressCache', async () => {});
  t.mock.method(Batch, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  const rollup = t.mock.method(Batch, 'findOneAndUpdate', async () => null);

  for (const status of ['paused', 'queued', 'downloading', 'muxing']) {
    await t.test(`status at completion: ${status}`, async (sub) => {
      const jobId = `job-${status}`;
      const job = { sourceUrl: 'https://example.com/video', mode: 'video', container: 'mp4',
        formatSelector: 'best', title: jobId, status: 'queued', batchId: 'batch' };
      sub.mock.method(Job, 'findById', () => Object.assign(Promise.resolve(job), {
        select: () => ({ lean: async () => ({ status: job.status }) }),
      }));
      sub.mock.method(Job, 'findByIdAndUpdate', async (_, update) => Object.assign(job, update));
      let movedPath;
      sub.mock.method(Job, 'findOneAndUpdate', async (filter, update) => {
        assert.equal(filter._id, jobId);
        if (update.status === 'ready') {
          // Simulate a state change after the post-download read, at the completion DB write.
          job.status = status;
          movedPath = update.filePath;
        }
        return filter.status.$in.includes(job.status) ? Object.assign(job, update) : null;
      });
      const before = rollup.mock.callCount();
      await processJob({ data: { jobId } }, {
        resolvePublicUrl: async () => ({ hostname: 'example.com', addresses: [] }),
        createPinnedSsrfProxy: async () => ({ proxyUrl: 'http://localhost:3128', close: async () => {} }),
        runYtDlpDownload: async () => fs.writeFile(path.join(dir, '.mediavault-tmp', `${jobId}.mp4`), 'media'),
      });
      assert.ok(movedPath);
      assert.equal(rollup.mock.callCount(), before + 1);
      if (['paused', 'queued'].includes(status)) {
        assert.equal(job.status, status);
        assert.equal(job.filePath, undefined);
        await assert.rejects(fs.stat(movedPath), { code: 'ENOENT' });
      } else {
        assert.equal(job.status, 'ready');
        assert.equal(await fs.readFile(job.filePath, 'utf8'), 'media');
      }
    });
  }
});