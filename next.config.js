/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['pg', 'bcrypt'],
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          // Peleka web clients authenticate with Bearer tokens in the
          // Authorization header; they do not use cross-origin cookies.
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-Requested-With, Accept' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
