/// <reference types="vite/client" />

declare module '*.mjs?url' {
  const src: string
  export default src
}

declare module 'pdfjs-dist/build/pdf.worker.mjs?url' {
  const workerUrl: string
  export default workerUrl
}
