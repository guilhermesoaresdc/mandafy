import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
})

const config = [
  {
    // next-env.d.ts é gerado pelo Next e não deve ser editado; as regras de
    // estilo não se aplicam a ele.
    ignores: ['.next/**', 'node_modules/**', 'drizzle/**', 'next-env.d.ts'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: ['*.mjs', '*.config.ts'],
    rules: { 'import/no-anonymous-default-export': 'off' },
  },
]

export default config
