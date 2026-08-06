import { describe, it } from "vitest";
import { EegAnalyzer, EPOCH_SECONDS } from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";
const FS = MUSE_SAMPLE_RATE;
let seed=12345; function rnd(){seed=(seed*1103515245+12345)%2147483648;return seed/2147483648-0.5;}
function baselineWindow(t0=0){const n=Math.round(FS*EPOCH_SECONDS);const o=new Float64Array(n);for(let i=0;i<n;i++){const t=t0+i/FS;o[i]=14*rnd()+6*Math.sin(2*Math.PI*23.7*t)+4*Math.sin(2*Math.PI*31*t);}return o;}
function ictalWindow(t0=0){const n=Math.round(FS*EPOCH_SECONDS);const o=new Float64Array(n);for(let i=0;i<n;i++){const t=t0+i/FS;o[i]=70*Math.sin(2*Math.PI*3.5*t)+35*Math.sin(2*Math.PI*7*t);}return o;}
describe("probe",()=>{it("scores",()=>{
  const a=new EegAnalyzer();
  const base=[];for(let t=0;t<80;t++) base.push(a.analyze(baselineWindow(t),t).seizureScore);
  console.log("base max",Math.max(...base));
  const s=[];for(let t=80;t<90;t++){const e=a.analyze(ictalWindow(t),t);s.push([t,+e.seizureScore.toFixed(2),e.seizureAlert]);}
  console.log(s);
  a.analyze(baselineWindow(300),300);
  console.log(a.events.map(e=>[e.kind,e.t,e.duration]));
})});
