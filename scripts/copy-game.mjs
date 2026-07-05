import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
const SRC="index.html", OUT_DIR="dist/play", OUT=`${OUT_DIR}/index.html`;
if(!existsSync(SRC)){console.error("[copy-game] FATAL: index.html not found");process.exit(1);}
if(!existsSync("dist")){console.error("[copy-game] FATAL: dist/ missing — hub build must run first");process.exit(1);}
mkdirSync(OUT_DIR,{recursive:true}); copyFileSync(SRC,OUT);
const a=statSync(SRC).size,b=statSync(OUT).size;
if(a!==b){console.error(`[copy-game] FATAL: size mismatch ${a}!=${b}`);process.exit(1);}
console.log(`[copy-game] OK: ${SRC} -> ${OUT} (${b} bytes)`);
