import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Necessário para a imagem Docker: gera .next/standalone com só o que roda.
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,

  reactStrictMode: true,

  // Pacotes que só existem no servidor e não devem ser empacotados pelo bundler.
  serverExternalPackages: ['postgres', 'bullmq', 'ioredis'],

  experimental: {
    // Orçamento de performance (§13): transição horizontal entre sessões.
    viewTransition: true,
  },

  // Nenhum dado pessoal vaza em header de resposta.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
}

export default nextConfig
