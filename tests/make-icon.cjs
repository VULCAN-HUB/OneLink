const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const size = 256, sample = 3;
function capsule(x, y, ax, ay, bx, by, radius) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(x-ax-t*dx, y-ay-t*dy) <= radius;
}
function pixel(x,y) {
  const radius=52, xx=Math.max(24+radius-x,0,x-(232-radius)), yy=Math.max(24+radius-y,0,y-(232-radius));
  if (Math.hypot(xx,yy)>radius) return [0,0,0,0];
  const arrow = capsule(x,y,72,105,185,105,9) || capsule(x,y,165,84,186,105,9) || capsule(x,y,165,126,186,105,9) ||
    capsule(x,y,72,153,184,153,9) || capsule(x,y,72,153,93,132,9) || capsule(x,y,72,153,93,174,9);
  return arrow ? [255,255,255,255] : [211,84,0,255];
}
const raw=Buffer.alloc((size*4+1)*size);
for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
  const sums=[0,0,0,0]; for(let sy=0;sy<sample;sy++)for(let sx=0;sx<sample;sx++){const p=pixel(x+(sx+.5)/sample,y+(sy+.5)/sample);p.forEach((c,i)=>sums[i]+=c);}
  sums.forEach((c,i)=>raw[y*(size*4+1)+1+x*4+i]=Math.round(c/(sample*sample)));
}
function crc32(data){let c=0xffffffff;for(const byte of data){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([length,type,data,crc]);}
const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
const icoHeader=Buffer.alloc(22);icoHeader.writeUInt16LE(1,2);icoHeader.writeUInt16LE(1,4);icoHeader.writeUInt16LE(1,10);icoHeader.writeUInt16LE(32,12);icoHeader.writeUInt32LE(png.length,14);icoHeader.writeUInt32LE(22,18);
const dir=path.resolve(__dirname,'../assets');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'icon.png'),png);fs.writeFileSync(path.join(dir,'icon.ico'),Buffer.concat([icoHeader,png]));
