import { parseEnv } from './env.ts';

const env = parseEnv();
console.log(`MuteBetBot scaffold OK (${env.NODE_ENV})`);
