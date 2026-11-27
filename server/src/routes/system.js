const { execFile } = require('child_process');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const { promisify } = require('util');
const Job = require('../models/Job');
const { requireAdmin } = require('../middleware/auth');
const { remoteTunnel } = require('../utils/remoteTunnel');
const { parseDownloadTtlMinutes } = require('../utils/workerHelpers');
const { AppError } = require('../utils/errors');

const execFileAsync = promisify(execFile);
const router = express.Router();

let cachedToolVersionsPromise = null;
let cachedExtractorsPromise = null;

router.get('/remote', requireAdmin, (_req, res) => {
  return res.status(200).json({ tunnel: remoteTunnel.getStatus() });
});

router.post('/remote', requireAdmin, async (_req, res, next) => {
  try {
    const tunnel = await remoteTunnel.start();
    return res.status(200).json({ tunnel });
  } catch (err) {
    return next(
      new AppError(503, 'REMOTE_TUNNEL_UNAVAILABLE', err.message)
    );
  }
});

router.delete('/remote', requireAdmin, async (_req, res, next) => {
  try {
    const tunnel = await remoteTunnel.stop();
    return res.status(200).json({ tunnel });
  } catch (err) {
    return next(err);
  }
});

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

/**
 * Reads (and caches) every extractor reported by the installed yt-dlp build.
 * Extractor variants such as `youtube:tab` collapse to a single base provider.
 */
function readSupportedExtractorsOnce() {
  if (cachedExtractorsPromise) {
    return cachedExtractorsPromise;
  }

  cachedExtractorsPromise = execFileAsync('yt-dlp', ['--list-extractors'], {
    shell: false,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  })
    .then(({ stdout }) => {
      const extractors = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const providerSet = new Set();
      for (const name of extractors) {
        const base = name
          .replace(/\s*\(CURRENTLY BROKEN\)\s*$/i, '')
          .split(':')[0]
          .trim();
        if (base) {
          providerSet.add(base);
        }
      }
      return {
        totalExtractors: extractors.length,
        uniqueProviders: providerSet.size,
        providers: Array.from(providerSet).sort((a, b) => a.localeCompare(b)),
      };
    })
    .catch(() => ({
      totalExtractors: 0,
      uniqueProviders: 0,
      providers: [],
    }));

  return cachedExtractorsPromise;
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
 * GET /api/system/providers
 * Returns the full list of providers/extractors reported by the installed yt-dlp build.
 * Optional `?q=` filters provider names by substring.
 */
router.get('/providers', async (req, res, next) => {
  try {
    const catalog = await readSupportedExtractorsOnce();
    const query = String(req.query.q || '').trim().toLowerCase();
    const providers = query
      ? catalog.providers.filter((name) => name.toLowerCase().includes(query))
      : catalog.providers;

    return res.status(200).json({
      totalExtractors: catalog.totalExtractors,
      uniqueProviders: catalog.uniqueProviders,
      providers,
    });
  } catch (err) {
    return next(err);
  }
});

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

    const [tools, disk, activeJobsCount, queuedJobsCount, providerCatalog] =
      await Promise.all([
        readToolVersionsOnce(),
        computeTempDirectoryStats(downloadsDir),
        Job.countDocuments(activeFilter),
        Job.countDocuments(queuedFilter),
        readSupportedExtractorsOnce(),
      ]);

    return res.status(200).json({
      system: {
        ytDlpVersion: tools.ytDlpVersion,
        ffmpegInstalled: tools.ffmpegInstalled,
        supportedProvidersCount: providerCatalog.uniqueProviders,
        supportedExtractorsCount: providerCatalog.totalExtractors,
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
