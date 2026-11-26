/** @type {import('next').NextConfig} */
const internalApiUrl = (process.env.INTERNAL_API_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '');

const nextConfig = {
  allowedDevOrigins: ['*.trycloudflare.com'],
  output: 'standalone',
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: '**.ytimg.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'yt3.ggpht.com' },
      { protocol: 'https', hostname: '**.cdninstagram.com' },
      { protocol: 'https', hostname: '**.fbcdn.net' },
      { protocol: 'https', hostname: 'pbs.twimg.com' },
      { protocol: 'https', hostname: 'video.twimg.com' },
      { protocol: 'https', hostname: '**.dmcdn.net' },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${internalApiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
