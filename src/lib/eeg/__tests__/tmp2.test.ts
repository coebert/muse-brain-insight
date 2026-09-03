import { describe, it } from "vitest";
import { parseVitalDbWaveCsv, pairVitalDbCase } from "../vitaldb-waveform";
const FS=128;
function waveCsv(sec:number){const rows=["Time,SNUADC/EEG1_WAV,SNUADC/EEG2_WAV"];const n=sec*FS;
for(let i=0;i<n;i++){const t=i/FS;const v=20*Math.sin(2*Math.PI*10*t)+6*Math.sin(2*Math.PI*3*t)+2*Math.sin(i*12.9898);rows.push(`${t.toFixed(4)},${v.toFixed(3)},${(v*0.9).toFixed(3)}`);}return rows.join("\n");}
describe("p",()=>{it("q",()=>{const w=parseVitalDbWaveCsv(waveCsv(60));
const nums=Array.from({length:60},(_,t)=>({t,bis:45,sef:12,sr:0,emg:30,sqi:95,ce:{propofol:3}}));
const r=pairVitalDbCase({caseId:"42",age:68,sex:"M",asa:"3",aneType:"General",propofol:true,opioid:true} as any,w,nums as any,{strideSeconds:10});
console.log(JSON.stringify(r.points.map(p=>[p.atSeconds,p.appIndex,p.lagSeconds])), JSON.stringify(r.rejected));
});});
