/**
 * Declarações para imports com efeito colateral que não são TypeScript.
 * O TypeScript 6 passou a exigir declaração explícita para `import './x.css'`
 * (TS2882); sem isto o `tsc --noEmit` falha mesmo com o build funcionando.
 */
declare module '*.css'
declare module '*.svg'
