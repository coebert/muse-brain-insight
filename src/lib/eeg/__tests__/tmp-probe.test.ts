import { describe, it } from "vitest";
import { replayRawEeg } from "/dev-server/src/lib/eeg/replay";
describe("x", () => { it("y", () => {
const FS=128; const n=60*FS; const s=new Float64Array(n);
for(let i=0;i<n;i++){const t=i/FS; s[i]=20*Math.sin(2*Math.PI*10*t)+5*Math.sin(2*Math.PI*3*t)+2*(Math.random()-0.5);}
const r=replayRawEeg({samples:s,sampleRate:FS});
console.log(r.frames.length, JSON.stringify(r.frames.slice(0,3)), JSON.stringify(r.frames.slice(-2)));
}); });
