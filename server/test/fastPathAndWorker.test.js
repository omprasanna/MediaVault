const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildInspectArgs,
  canonicalizePlatformSlug,
  derivePlatformSlug,
  isValidPlatformSlug,
  validateMediaUrl,
} = require('../src/utils/ytdlp');
const { assertPublicUrl, isPrivateIp, resolvePublicUrl } = require('../src/utils/ssrf');
const { mapInspectResponse, sanitizeFilename } = require('../src/utils/formatMapper');
const {
  buildYtDlpJobArgs,
  detectMuxingPhase,
  enforce1080pSelector,
  moveToUniquePath,
  parseDownloadTtlMinutes,
  parseHumanSizeToBytes,
  parseYtDlpProgressLine,
  sanitizeFolderName,
} = require('../src/utils/workerHelpers');

test('validateMediaUrl accepts all 6 supported platforms and normalizes platform key', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://www.instagram.com/reel/C123456/', 'instagram'],
    ['https://www.facebook.com/watch/?v=123456', 'facebook'],
    ['https://fb.watch/abcd1234/', 'facebook'],
    ['https://x.com/user/status/1234567890', 'x'],
    ['https://twitter.com/user/status/1234567890', 'x'],
    ['https://www.dailymotion.com/video/x8abcde', 'dailymotion'],
    ['https://dai.ly/x8abcde', 'dailymotion'],
  ];

  for (const [input, expectedPlatform] of cases) {
    const res = validateMediaUrl(input);
    assert.equal(res.platform, expectedPlatform);
  }
});

test('validateMediaUrl rejects non-http, credential, flag, and private-host inputs', () => {
  const invalidInputs = [
    '',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '--exec=id',
    'https://user:pass@www.youtube.com/watch?v=abc',
    'http://localhost/video',
    'http://api.internal./secret',
    'http://127.0.0.1/video.mp4',
    'http://10.0.0.1/video.mp4',
    'http://[::1]/video.mp4',
  ];

  for (const bad of invalidInputs) {
    assert.throws(() => validateMediaUrl(bad), { code: 'INVALID_URL' });
  }
});

test('validateMediaUrl accepts any public yt-dlp URL and derives a safe platform slug', () => {
  const cases = [
    ['https://example.com/video.mp4', 'example.com'],
    ['https://www.tiktok.com/@creator/video/123', 'tiktok.com'],
    ['https://player.vimeo.com/video/123', 'vimeo.com'],
    ['https://soundcloud.com/artist/track', 'soundcloud.com'],
    ['https://youtube.com.evil.com/watch?v=abc', 'evil.com'],
    ['https://www.bbc.co.uk/iplayer/episode/abc', 'bbc.co.uk'],
  ];

  for (const [input, expectedPlatform] of cases) {
    const res = validateMediaUrl(input);
    assert.equal(res.platform, expectedPlatform);
  }

  // Hostname spoofing must never inherit a trusted platform identity.
  assert.notEqual(
    validateMediaUrl('https://youtube.com.evil.com/watch?v=abc').platform,
    'youtube'
  );
});

test('derivePlatformSlug and isValidPlatformSlug keep cookie filenames safe', () => {
  assert.equal(derivePlatformSlug('www.tiktok.com'), 'tiktok.com');
  assert.equal(derivePlatformSlug('player.vimeo.com'), 'vimeo.com');
  assert.equal(derivePlatformSlug('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(derivePlatformSlug('www.hotstar.com'), 'hotstar.com');
  assert.equal(derivePlatformSlug('127.0.0.1'), 'ip-127-0-0-1');

  for (const slug of ['youtube', 'tiktok.com', 'bbc.co.uk', 'ip-127-0-0-1']) {
    assert.equal(isValidPlatformSlug(slug), true, `Expected ${slug} to be valid`);
  }
  for (const slug of ['', '../etc/passwd', 'a/b', 'a\\b', '..', '-leading']) {
    assert.equal(isValidPlatformSlug(slug), false, `Expected ${slug} to be invalid`);
  }
});

test('isPrivateIp and assertPublicUrl block private/loopback/IMDS/IPv6-mapped ranges', async () => {
  const privateIps = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ];

  for (const ip of privateIps) {
    assert.equal(isPrivateIp(ip), true, `Expected ${ip} to be flagged private`);
  }

  const publicIps = ['8.8.8.8', '142.250.190.46', '2607:f8b0:4005:80b::200e'];
  for (const ip of publicIps) {
    assert.equal(isPrivateIp(ip), false, `Expected ${ip} to be public`);
  }

  await assert.rejects(
    () => assertPublicUrl('http://127.0.0.1:5000/api/health'),
    { code: 'INVALID_URL' }
  );
  await assert.rejects(
    () =>
      assertPublicUrl('https://cdn.example.com/video.mp4', {
        lookup: async () => [{ address: '192.168.1.50', family: 4 }],
      }),
    { code: 'INVALID_URL' }
  );

  const ok = await assertPublicUrl('https://cdn.example.com/video.mp4', {
    lookup: async () => [{ address: '142.250.190.46', family: 4 }],
  });
  assert.equal(ok.hostname, 'cdn.example.com');
});

test('formatMapper filters >1080p, separates direct vs worker, and maps stream-copy containers', () => {
  const sample = {
    title: 'Sample Test: Video / 4K!',
    thumbnail: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    duration: 90,
    formats: [
      { format_id: 'sb0', ext: 'mhtml', vcodec: 'images', acodec: 'none' },
      {
        format_id: '401',
        ext: 'mp4',
        height: 2160,
        fps: 60,
        vcodec: 'av01.0.13M.08',
        acodec: 'none',
        protocol: 'https',
        url: 'https://cdn.example.com/4k',
      },
      {
        format_id: '271',
        ext: 'webm',
        height: 1440,
        fps: 60,
        vcodec: 'vp9',
        acodec: 'none',
        protocol: 'https',
        url: 'https://cdn.example.com/1440',
      },
      {
        format_id: '137',
        ext: 'mp4',
        height: 1080,
        fps: 30,
        vcodec: 'avc1.640028',
        acodec: 'none',
        protocol: 'https',
        filesize: 20000000,
        url: 'https://cdn.example.com/1080_avc1',
      },
      {
        format_id: '248',
        ext: 'webm',
        height: 1080,
        fps: 30,
        vcodec: 'vp09.00.40.08',
        acodec: 'none',
        protocol: 'https',
        filesize: 15000000,
        url: 'https://cdn.example.com/1080_vp9',
      },
      {
        format_id: '999',
        ext: 'mp4',
        height: 720,
        fps: 30,
        vcodec: 'hev1.1.6.L93.B0',
        acodec: 'none',
        protocol: 'https',
        url: 'https://cdn.example.com/720_hevc',
      },
      {
        format_id: '18',
        ext: 'mp4',
        height: 360,
        fps: 30,
        vcodec: 'avc1.42001E',
        acodec: 'mp4a.40.2',
        protocol: 'https',
        url: 'https://cdn.example.com/360_direct',
        http_headers: { 'User-Agent': 'yt-dlp-ua', Referer: 'https://www.youtube.com/' },
      },
      {
        format_id: 'hls-720',
        ext: 'mp4',
        height: 720,
        fps: 30,
        vcodec: 'avc1.4d401f',
        acodec: 'mp4a.40.2',
        protocol: 'm3u8_native',
        url: 'https://cdn.example.com/playlist.m3u8',
      },
      {
        format_id: '140',
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        abr: 128,
        protocol: 'https',
        filesize: 1500000,
        url: 'https://cdn.example.com/audio_aac',
      },
      {
        format_id: '251',
        ext: 'webm',
        vcodec: 'none',
        acodec: 'opus',
        abr: 160,
        protocol: 'https',
        filesize: 1600000,
        url: 'https://cdn.example.com/audio_opus',
      },
    ],
  };

  const mapped = mapInspectResponse(sample, {
    platform: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=abc',
  });

  assert.equal(mapped.isPlaylist, false);
  assert.ok(mapped.formats.every((f) => f.height === null || f.height <= 1080));

  const direct360 = mapped.formats.find((f) => f.formatId === '18');
  assert.equal(direct360.delivery, 'direct');
  assert.equal(direct360.isDirect, true);
  assert.equal(direct360._httpHeaders['User-Agent'], 'yt-dlp-ua');

  const hls720 = mapped.formats.find((f) => f.formatId === 'hls-720');
  assert.equal(hls720.delivery, 'worker');
  assert.equal(hls720.isDirect, false);

  const mp41080 = mapped.formats.find((f) => f.formatId === '137+140');
  assert.equal(mp41080.container, 'mp4');
  assert.equal(mp41080.delivery, 'worker');

  const webm1080 = mapped.formats.find((f) => f.formatId === '248+251');
  assert.equal(webm1080.container, 'webm');
  assert.equal(webm1080.delivery, 'worker');

  const mkv720 = mapped.formats.find((f) => f.height === 720 && f.container === 'mkv');
  assert.ok(mkv720, 'Mismatched HEVC codec should fall back to MKV stream-copy');
  assert.equal(mkv720.delivery, 'worker');

  const mp3 = mapped.formats.find((f) => f.container === 'mp3');
  assert.equal(mp3.mode, 'audio');
  assert.equal(mp3.delivery, 'worker');

  assert.equal(sanitizeFilename('Sample Test: Video / 4K!', 'mp4'), 'Sample_Test_Video_4K.mp4');
});

test('workerHelpers enforce --js-runtimes node, 1080p cap, stream-copy, and conditional cookies', () => {
  assert.equal(
    enforce1080pSelector('bestvideo+bestaudio', 'video', 'mp4'),
    'bestvideo[height<=1080]+bestaudio'
  );
  assert.equal(
    enforce1080pSelector('bestvideo[ext=mp4]+bestaudio[ext=m4a]', 'video', 'mp4'),
    'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]'
  );
  assert.match(enforce1080pSelector('bestvideo[height<=2160]+bestaudio', 'video', 'mp4'), /1080/);
  for (const [selector, container] of [
    [
      'bestvideo[height<=720][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[height<=720]',
      'mp4',
    ],
    [
      'bestvideo[height<=480][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=480][ext=mp4]/bestvideo[height<=480]+bestaudio/best[height<=480]',
      'mp4',
    ],
    [
      'bestvideo[height<=360][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=360][ext=mp4]/bestvideo[height<=360]+bestaudio/best[height<=360]',
      'mp4',
    ],
    [
      'bestvideo[height<=1080][vcodec^=vp09]+bestaudio[acodec^=opus]/bestvideo[height<=1080][vcodec^=vp9]+bestaudio[acodec^=opus]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
      'webm',
    ],
    [
      'bestvideo[height<=720][vcodec^=vp09]+bestaudio[acodec^=opus]/bestvideo[height<=720][vcodec^=vp9]+bestaudio[acodec^=opus]/bestvideo[height<=720]+bestaudio/best[height<=720]',
      'webm',
    ],
    [
      'bestvideo[height<=480][vcodec^=vp09]+bestaudio[acodec^=opus]/bestvideo[height<=480][vcodec^=vp9]+bestaudio[acodec^=opus]/bestvideo[height<=480]+bestaudio/best[height<=480]',
      'webm',
    ],
    ['bestvideo[height<=720]+bestaudio/best[height<=720]', 'mkv'],
    ['bestvideo[height<=480]+bestaudio/best[height<=480]', 'mkv'],
  ]) {
    assert.equal(enforce1080pSelector(selector, 'video', container), selector);
  }
  assert.throws(() => enforce1080pSelector('137+140; rm -rf /', 'video', 'mp4'), {
    code: 'INVALID_REQUEST',
  });

  const videoArgs = buildYtDlpJobArgs({
    url: 'https://www.youtube.com/watch?v=abc',
    mode: 'video',
    container: 'mp4',
    formatSelector: '137+140',
    outputTemplate: '/data/downloads/job1.%(ext)s',
    cookiePath: null,
  });
  assert.equal(videoArgs[0], '--js-runtimes');
  assert.equal(videoArgs[1], 'node');
  assert.ok(videoArgs.includes('--continue'));
  assert.ok(videoArgs.includes('--socket-timeout'));
  assert.ok(videoArgs.includes('--merge-output-format'));
  assert.ok(videoArgs.includes('Merger+ffmpeg_o:-c copy'));
  assert.ok(!videoArgs.includes('--cookies'));

  const audioArgs = buildYtDlpJobArgs({
    url: 'https://www.youtube.com/watch?v=abc',
    mode: 'audio',
    container: 'mp3',
    formatSelector: 'bestaudio/best',
    outputTemplate: '/data/downloads/job2.%(ext)s',
    cookiePath: '/data/cookies/youtube.txt',
  });
  assert.ok(audioArgs.includes('--continue'));
  assert.ok(audioArgs.includes('--audio-format'));
  assert.ok(audioArgs.includes('mp3'));
  assert.ok(audioArgs.includes('--audio-quality'));
  assert.ok(audioArgs.includes('--cookies'));
  assert.ok(audioArgs.includes('/data/cookies/youtube.txt'));

  const p1 = parseYtDlpProgressLine(
    '[download]  45.6% of ~120.50MiB at  2.45MiB/s ETA 00:15'
  );
  assert.deepEqual(p1, {
    percentage: 45.6,
    totalSize: '120.50MiB',
    downloadSpeed: '2.45MiB/s',
    eta: '00:15',
  });

  const p2 = parseYtDlpProgressLine('[download] 100% of 10.20MiB in 00:02 at 5.10MiB/s');
  assert.equal(p2.percentage, 100);

  assert.equal(detectMuxingPhase('[Merger] Merging formats into "/data/downloads/j1.mp4"'), true);
  assert.equal(detectMuxingPhase('[ExtractAudio] Destination: /data/downloads/j2.mp3'), true);
  assert.equal(detectMuxingPhase('[download] 50.0% of 10MiB at 1MiB/s ETA 00:05'), false);
});

test('parseDownloadTtlMinutes treats unset, zero, or negative as 0 (persistent mode)', () => {
  assert.equal(parseDownloadTtlMinutes(undefined), 0);
  assert.equal(parseDownloadTtlMinutes(null), 0);
  assert.equal(parseDownloadTtlMinutes(''), 0);
  assert.equal(parseDownloadTtlMinutes('0'), 0);
  assert.equal(parseDownloadTtlMinutes('-5'), 0);
  assert.equal(parseDownloadTtlMinutes('30'), 30);
});

test('sanitizeFolderName and moveToUniquePath store clean filenames and resolve collisions', async () => {
  assert.equal(sanitizeFolderName('My Favorite / Mix: 2026!'), 'My_Favorite_Mix_2026');
  assert.equal(sanitizeFolderName('../..///'), 'Playlist');

  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-move-test-'));
  try {
    const destDir = path.join(tempRoot, sanitizeFolderName('Lo-Fi / Beats'));
    const src1 = path.join(tempRoot, 'job1.mp3');
    const src2 = path.join(tempRoot, 'job2.mp3');
    const src3 = path.join(tempRoot, 'job3.mp3');

    await Promise.all([
      fs.promises.writeFile(src1, 'one'),
      fs.promises.writeFile(src2, 'two'),
      fs.promises.writeFile(src3, 'three'),
    ]);

    const first = await moveToUniquePath(src1, destDir, 'Track_One.mp3');
    const second = await moveToUniquePath(src2, destDir, 'Track_One.mp3');
    const third = await moveToUniquePath(src3, destDir, 'Track_One.mp3');

    assert.equal(first.fileName, 'Track_One.mp3');
    assert.equal(second.fileName, 'Track_One_(2).mp3');
    assert.equal(third.fileName, 'Track_One_(3).mp3');
    assert.equal(await fs.promises.readFile(second.filePath, 'utf8'), 'two');
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('buildInspectArgs omits --playlist-end when unlimited and applies it when capped', () => {
  const unlimitedArgs = buildInspectArgs({
    playlistMode: true,
    maxPlaylistItems: 0,
    url: 'https://www.youtube.com/playlist?list=PL123',
  });
  assert.ok(unlimitedArgs.includes('--flat-playlist'));
  assert.ok(!unlimitedArgs.includes('--playlist-end'));

  const cappedArgs = buildInspectArgs({
    playlistMode: true,
    maxPlaylistItems: 25,
    url: 'https://www.youtube.com/playlist?list=PL123',
  });
  const endIdx = cappedArgs.indexOf('--playlist-end');
  assert.ok(endIdx !== -1);
  assert.equal(cappedArgs[endIdx + 1], '25');
});

test('formatMapper and workerHelpers handle portrait <=1080p HLS streams, omitted acodec, and @ in format_id', () => {
  const dailymotionSample = {
    title: 'Portrait Art Sample',
    duration: 22,
    thumbnail: 'https://cdn.example.com/dm.jpg',
    formats: [
      {
        format_id: 'hls-0_aac_q1-English',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'none',
        tbr: null,
        format_note: 'English, low',
        url: 'https://vod.example.com/a1.m3u8',
      },
      {
        format_id: 'hls-0_aac_q2-English',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'none',
        tbr: null,
        format_note: 'English, high',
        url: 'https://vod.example.com/a2.m3u8',
      },
      {
        format_id: 'hls-380',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'avc1.42001e',
        acodec: 'none',
        width: 360,
        height: 640,
        tbr: 460,
        url: 'https://vod.example.com/v360.m3u8',
      },
      {
        format_id: 'hls-480',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'avc1.64001f',
        acodec: 'none',
        width: 480,
        height: 848,
        tbr: 836,
        url: 'https://vod.example.com/v480.m3u8',
      },
      {
        format_id: 'hls-720@60',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'avc1.640028',
        acodec: 'none',
        width: 720,
        height: 1280,
        fps: 60,
        tbr: 2654,
        url: 'https://vod.example.com/v720.m3u8',
      },
      {
        format_id: 'hls-1080@60-0',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'avc1.64002a',
        acodec: 'none',
        width: 1080,
        height: 1920,
        fps: 60,
        tbr: 5716,
        url: 'https://vod.example.com/v1080_h264.m3u8',
      },
      {
        format_id: 'hls-1080@60-1',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'av01.0.09M.08',
        acodec: 'none',
        width: 1080,
        height: 1920,
        fps: 60,
        tbr: 3999,
        url: 'https://vod.example.com/v1080_av1.m3u8',
      },
      {
        format_id: 'hls-1440@60',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'avc1.640033',
        acodec: 'none',
        width: 1440,
        height: 2560,
        fps: 60,
        tbr: 9000,
        url: 'https://vod.example.com/v1440.m3u8',
      },
    ],
  };

  const mapped = mapInspectResponse(dailymotionSample, {
    platform: 'dailymotion',
    sourceUrl: 'https://www.dailymotion.com/video/xbyr5ju',
  });

  assert.equal(mapped.isPlaylist, false);
  assert.ok(mapped.formats.every((f) => f.height === null || f.height <= 1080));
  assert.ok(!mapped.formats.some((f) => f.formatId.includes('hls-1440@60')));

  const mp41080 = mapped.formats.find((f) => f.formatId === 'hls-1080@60-0+hls-0_aac_q2-English');
  assert.ok(mp41080, 'Expected portrait 1080p MP4 using higher quality audio q2');
  assert.equal(mp41080.container, 'mp4');
  assert.equal(mp41080.height, 1080);
  assert.equal(mp41080.acodec, 'aac');

  const mp4720 = mapped.formats.find((f) => f.formatId === 'hls-720@60+hls-0_aac_q2-English');
  assert.ok(mp4720, 'Expected portrait 720p MP4');
  assert.equal(mp4720.container, 'mp4');
  assert.equal(mp4720.height, 720);

  const mp3 = mapped.formats.find((f) => f.container === 'mp3');
  assert.ok(mp3);
  assert.equal(mp3.mode, 'audio');

  assert.equal(
    enforce1080pSelector('hls-1080@60-0+hls-0_aac_q2-English', 'video', 'mp4'),
    'hls-1080@60-0+hls-0_aac_q2-English'
  );
  assert.equal(
    enforce1080pSelector('hls-720@60+hls-0_aac_q2-English', 'video', 'mp4'),
    'hls-720@60+hls-0_aac_q2-English'
  );
});

test('resolvePublicUrl falls back to c-ares resolve4/resolve6 on EAI_AGAIN while still blocking private IPs', async () => {
  const eaiAgain = Object.assign(new Error('getaddrinfo EAI_AGAIN cdn.example.com'), {
    code: 'EAI_AGAIN',
  });
  const eTimeout = Object.assign(new Error('queryAaaa ETIMEOUT cdn.example.com'), {
    code: 'ETIMEOUT',
  });
  const eNotFound = Object.assign(new Error('getaddrinfo ENOTFOUND cdn.example.com'), {
    code: 'ENOTFOUND',
  });

  const resolved = await resolvePublicUrl('https://cdn.example.com/video.mp4', {
    allowFallback: true,
    lookup: async () => {
      throw eaiAgain;
    },
    resolve4: async () => ['54.192.151.51'],
    resolve6: async () => {
      throw eTimeout;
    },
  });
  assert.deepEqual(resolved.addresses, [{ address: '54.192.151.51', family: 4 }]);

  await assert.rejects(
    () =>
      resolvePublicUrl('https://cdn.example.com/video.mp4', {
        allowFallback: true,
        lookup: async () => {
          throw eaiAgain;
        },
        resolve4: async () => ['54.192.151.51'],
        resolve6: async () => ['::1'],
      }),
    { code: 'INVALID_URL' }
  );

  let resolve4Called = false;
  await assert.rejects(
    () =>
      resolvePublicUrl('https://cdn.example.com/video.mp4', {
        allowFallback: true,
        lookup: async () => {
          throw eNotFound;
        },
        resolve4: async () => {
          resolve4Called = true;
          return ['54.192.151.51'];
        },
        resolve6: async () => [],
      }),
    { code: 'INVALID_URL' }
  );
  assert.equal(resolve4Called, false);
});

test('canonicalizePlatformSlug normalizes hosts, URLs, and aliases while rejecting unsafe targets', () => {
  assert.equal(canonicalizePlatformSlug('www.hotstar.com'), 'hotstar.com');
  assert.equal(canonicalizePlatformSlug('https://www.hotstar.com/in/movies/test/1260022902'), 'hotstar.com');
  assert.equal(canonicalizePlatformSlug('hotstar.com'), 'hotstar.com');
  assert.equal(canonicalizePlatformSlug('www.youtube.com'), 'youtube');
  assert.equal(canonicalizePlatformSlug('twitter.com'), 'x');
  assert.equal(canonicalizePlatformSlug('dai.ly'), 'dailymotion');
  assert.equal(canonicalizePlatformSlug('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(canonicalizePlatformSlug('youtube'), 'youtube');
  assert.equal(canonicalizePlatformSlug('localhost'), null);
  assert.equal(canonicalizePlatformSlug('app.local'), null);
  assert.equal(canonicalizePlatformSlug('internal.internal'), null);
  assert.equal(canonicalizePlatformSlug('../etc/passwd'), null);
  assert.equal(canonicalizePlatformSlug(''), null);
});

test('parseHumanSizeToBytes parses yt-dlp total sizes and sanitizes unknown tokens', () => {
  assert.equal(parseHumanSizeToBytes('120.50MiB'), Math.round(120.5 * 1024 * 1024));
  assert.equal(parseHumanSizeToBytes('~1.5GiB'), Math.round(1.5 * 1024 * 1024 * 1024));
  assert.equal(parseHumanSizeToBytes('512KiB'), 512 * 1024);
  assert.equal(parseHumanSizeToBytes('50MB'), 50 * 1000 * 1000);
  assert.equal(parseHumanSizeToBytes('512B'), 512);
  assert.equal(parseHumanSizeToBytes('Unknown'), 0);
  assert.equal(parseHumanSizeToBytes('N/A'), 0);
  assert.equal(parseHumanSizeToBytes(null), 0);

  const parsedUnknown = parseYtDlpProgressLine('[download]  15.0% of Unknown at 1.2MiB/s ETA 00:10');
  assert.deepEqual(parsedUnknown, {
    percentage: 15,
    totalSize: null,
    downloadSpeed: '1.2MiB/s',
    eta: '00:10',
  });
});

test('moveToUniquePath atomically reserves destinations under concurrent writes and EXDEV fallback', async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mv-move-race-'));

  try {
    // 1. Concurrent moves via hardlink reservation never overwrite each other
    const linkDestDir = path.join(tempRoot, 'link-dest');
    const srcPaths = await Promise.all(
      Array.from({ length: 12 }, async (_, idx) => {
        const src = path.join(tempRoot, `src_${idx}.mp4`);
        await fs.promises.writeFile(src, `payload-${idx}`);
        return src;
      })
    );

    const moved = await Promise.all(
      srcPaths.map((src) => moveToUniquePath(src, linkDestDir, 'Shared_Title.mp4'))
    );

    const destSet = new Set(moved.map((m) => m.filePath));
    assert.equal(destSet.size, 12);

    const contents = await Promise.all(
      moved.map((m) => fs.promises.readFile(m.filePath, 'utf8'))
    );
    assert.equal(new Set(contents).size, 12);
    for (let idx = 0; idx < 12; idx += 1) {
      assert.ok(contents.includes(`payload-${idx}`));
      assert.equal(fs.existsSync(srcPaths[idx]), false);
    }

    // 2. Cross-device fallback (COPYFILE_EXCL) reserves unique destinations under concurrency
    const exdevDestDir = path.join(tempRoot, 'exdev-dest');
    const exdevSrcs = await Promise.all(
      Array.from({ length: 6 }, async (_, idx) => {
        const src = path.join(tempRoot, `exdev_${idx}.mp4`);
        await fs.promises.writeFile(src, `exdev-payload-${idx}`);
        return src;
      })
    );

    const origLink = fs.promises.link;
    fs.promises.link = async () => {
      const err = new Error('Cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    };

    try {
      const exdevMoved = await Promise.all(
        exdevSrcs.map((src) => moveToUniquePath(src, exdevDestDir, 'Cross_Device.mp4'))
      );

      assert.equal(new Set(exdevMoved.map((m) => m.filePath)).size, 6);
      const exdevContents = await Promise.all(
        exdevMoved.map((m) => fs.promises.readFile(m.filePath, 'utf8'))
      );
      assert.equal(new Set(exdevContents).size, 6);
      for (let idx = 0; idx < 6; idx += 1) {
        assert.ok(exdevContents.includes(`exdev-payload-${idx}`));
        assert.equal(fs.existsSync(exdevSrcs[idx]), false);
      }
    } finally {
      fs.promises.link = origLink;
    }
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});
