// Copies the Basic Pitch model (Apache-2.0, Spotify) from node_modules into public/ so it is served with the app.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/models/basic-pitch', { recursive: true });
cpSync('node_modules/@spotify/basic-pitch/model', 'public/models/basic-pitch', { recursive: true });
console.log('Basic Pitch model copied to public/models/basic-pitch');
