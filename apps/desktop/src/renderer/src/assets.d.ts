declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg?raw' {
  const svg: string
  export default svg
}

interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true; query: '?raw'; import: 'default' }): Record<string, T>
}
