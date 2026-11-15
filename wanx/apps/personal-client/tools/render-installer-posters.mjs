// Exact product typography, rendered from editable SVG sources; no old screenshots.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(new URL('../../builder/package.json',import.meta.url));
const sharp=require('sharp');
const root=fileURLToPath(new URL('../',import.meta.url));
const output=process.argv[2];
if(!output)throw new Error('OUTPUT_DIRECTORY_REQUIRED');
await mkdir(output,{recursive:true});
for(const name of ['memory','space','my-ai'])await sharp(await readFile(path.join(root,'resources/installer/posters',`memobox-${name}.svg`))).png().toFile(path.join(output,`${name}.png`));
