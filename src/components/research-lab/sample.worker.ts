import { evaluateSample, type Analysis } from "./sample-presentation";

self.onmessage = (event: MessageEvent<{ analysis: Analysis; sample: string }>) => {
  const { analysis, sample } = event.data;
  self.postMessage(evaluateSample(analysis, sample));
};
