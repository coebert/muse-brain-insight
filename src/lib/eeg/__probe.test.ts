import { describe, expect, it } from "vitest";
import { EegAnalyzer, EPOCH_SECONDS } from "@/lib/eeg/analysis";
import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";
const FS = MUSE_SAMPLE_RATE;
function activeWindow(t0=0): Float64Array {
  const n = Math.round(FS * EPOCH_SECONDS); const out = new Float64Array(n);
  for (let i=0;i<n;i++){const t=t0+i/FS; out[i]=12*Math.sin(2*Math.PI*10*t)+8*Math.sin(2*Math.PI*3.3*t)+3*Math.sin(2*Math.PI*17.7*t);} return out;
}
function ictalWindow(t0=0): Float64Array {
  const n = Math.round(FS * EPOCH_SECONDS); const out = new Float64Array(n);
  for (let i=0;i<n;i++){const t=t0+i/FS; out[i]=70*Math.sin(2*Math.PI*3.5*t)+35*Math.sin(2*Math.PI*7*t)+10*Math.sin(2*Math.PI*10.5*t);} return out;
}
describe("probe",()=>{it("scores",()=>{
  const a=new EegAnalyzer();
  for(let t=0;t<80;t++) a.analyze(activeWindow(t),t);
  const scores=[]; for(let t=80;t<90;t++) scores.push(a.analyze(ictalWindow(t),t));
  console.log(scores.map(e=>[e.seizureScore.toFixed(2),e.seizureAlert]));
  console.log(a.events.map(e=>[e.kind,e.t,e.duration]));
}) });
