const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMediaUrl } = require('../src/utils/ytdlp');
const { assertPublicUrl, isPrivateIp } = require('../src/utils/ssrf');
const { mapInspectResponse, sanitizeFilename } = require('../src/utils/formatMapper');
const {
  buildYtDlpJobArgs,
  detectMuxingPhase,
  enforce1080pSelector,
  parseYtDlpProgressLine,
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

test('validateMediaUrl rejects disallowed domains, prefix spoofs, non-http, and flags', () => {
  const invalidInputs = [
    '',
    'https://example.com/video.mp4',
    'https://youtube.com.evil.com/watch?v=abc',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '--exec=id',
    'https://user:pass@www.youtube.com/watch?v=abc',
  ];

  for (const bad of invalidInputs) {
    assert.throws(() => validateMediaUrl(bad), { code: 'INVALID_URL' });
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
