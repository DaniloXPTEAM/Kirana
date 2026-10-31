import { randomBytes } from 'node:crypto';
const key = randomBytes(32).toString('base64url');
console.log(key);
console.error('Copy this one-time output into .env as GATEWAY_API_KEY. It authenticates only to your localhost gateway.');
