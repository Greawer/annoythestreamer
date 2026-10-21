/** @type {import('next').NextConfig} */
const backendUrl = process.env.ATS_BACKEND_URL || 'http://127.0.0.1:420';

const nextConfig = {
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/static/:path*',
          destination: `${backendUrl}/static/:path*`,
        },
      ],
      afterFiles: [
        {
          source: '/api/:path*',
          destination: `${backendUrl}/:path*`,
        },
      ],
    }
  },
}

export default nextConfig