const { execFile } = require('child_process');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const { promisify } = require('util');
const Job = require('../models/Job');
const { parseDownloadTtlMinutes } = require('../utils/workerHelpers');

const execFileAsync = promisify(execFile);
const router = express.Router();

let cachedToolVersionsPromise = null;

function readToolVersionsOnce() {
  if (cachedToolVersionsPromise) {
    return cachedToolVersionsPromise;
  }

  cachedToolVersionsPromise = Promise.all([
    execFileAsync('yt-dlp', ['--version'], { shell: false, timeout: 5000 })
      .then(({ stdout }) => String(stdout || '').trim() || 'unknown')
      .catch(() => 'unavailable'),
    execFileAsync('ffmpeg', ['-version'], { shell: false, timeout: 5000 })
      .then(({ stdout }) => Boolean(String(stdout || '').trim()))
      .catch(() => false),
  ]).then(([ytDlpVersion, ffmpegInstalled]) => ({
    ytDlpVersion,
    ffmpegInstalled,
  }));

  return cachedToolVersionsPromise;
}

async function sumDirectoryBytes(dirPath) {
  let totalBytes = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        if (entry.name === '.gitkeep' || entry.name === '.mediavault-tmp') {
          return 0;
        }
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return sumDirectoryBytes(fullPath);
        }
        if (entry.isFile()) {
          const st = await fs.promises.stat(fullPath).catch(() => null);
          return st && Number.isFinite(st.size) ? st.size : 0;
        }
        return 0;
      })
    );
    for (const size of sizes) {
      totalBytes += size;
    }
  } catch {
    return 0;
  }
  return totalBytes;
}

async function computeTempDirectoryStats(downloadsDir) {
  const tempStorageBytes = await sumDirectoryBytes(downloadsDir);

  let tempDiskFreeBytes = 0;
  try {
    const fsStats = await fs.promises.statfs(downloadsDir);
    tempDiskFreeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  } catch {
    tempDiskFreeBytes = 0;
  }

  return { tempStorageBytes, tempDiskFreeBytes };
}

/**
 * GET /api/system/status
 * Returns live binary versions, temp storage metrics, worker config, and job counts.
 */
router.get('/status', async (req, res, next) => {
  try {
    const downloadsDir = path.resolve(process.env.DOWNLOADS_DIR || '/data/downloads');
    const userId = req.user?.id;
    const activeFilter = userId
      ? { userId, status: { $in: ['downloading', 'muxing'] } }
      : { status: { $in: ['downloading', 'muxing'] } };
    const queuedFilter = userId
      ? { userId, status: 'queued' }
      : { status: 'queued' };

    const [tools, disk, activeJobsCount, queuedJobsCount] = await Promise.all([
      readToolVersionsOnce(),
      computeTempDirectoryStats(downloadsDir),
      Job.countDocuments(activeFilter),
      Job.countDocuments(queuedFilter),
    ]);

    return res.status(200).json({
      system: {
        ytDlpVersion: tools.ytDlpVersion,
        ffmpegInstalled: tools.ffmpegInstalled,
        tempStorageBytes: disk.tempStorageBytes,
        tempDiskFreeBytes: disk.tempDiskFreeBytes,
        downloadTtlMinutes: parseDownloadTtlMinutes(process.env.DOWNLOAD_TTL_MINUTES),
        workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 2),
        allowRegistration:
          String(process.env.ALLOW_REGISTRATION || '').toLowerCase() === 'true',
        activeJobsCount,
        queuedJobsCount,
        dbConnected: mongoose.connection.readyState === 1,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
