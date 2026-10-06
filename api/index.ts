import { createVercelApp } from '../server/src/vercel.ts';

// The Vercel Function serving /api/* (see vercel.json's rewrites). Vercel runs this file with
// Node 24, which runs the server's TypeScript directly: there's no build step for the API.
export default createVercelApp();
