import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import learning from "@/lib/eeg/research-waveform-learning.json";

const report = "https://github.com/coebert/muse-brain-insight/blob/research/eeg-baselines/research/learning/README.md";

export function ResearchLearningPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Propofol and seizure research</CardTitle>
        <CardDescription>Retrospective tests on recorded EEG, 21 November 2026.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <section className="space-y-2">
          <h3 className="font-medium">Propofol protocol state across centres</h3>
          <p>Each model learned at one centre and scored participants at the other. AUROC measures separation of baseline from the study’s sedated condition.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr className="border-b"><th scope="col" className="py-1">Training → test</th><th scope="col">Frontal</th><th scope="col">Six derivations</th></tr></thead>
              <tbody>{learning.propofol.map((row) => (
                <tr key={row.direction} className="border-b"><th scope="row" className="py-1 font-normal">{row.direction}</th><td>{row.frontal.toFixed(2)}</td><td>{row.broader.toFixed(2)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <p className="text-muted-foreground">Behavioural task performance and reported awareness are different endpoints. The report includes a separate analysis of correct responses.</p>
        </section>
        <section className="space-y-2">
          <h3 className="font-medium">Seizure events on held-out Helsinki neonates</h3>
          <p>{learning.neonates} neonates contributed {learning.hours.toFixed(1)} hours of labelled EEG. A detection required an alarm to start during an expert-majority seizure lasting at least ten seconds.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr className="border-b"><th scope="col" className="py-1">Montage</th><th scope="col">Detected</th><th scope="col">False alarms / background hour</th></tr></thead>
              <tbody>{learning.seizures.map((row) => (
                <tr key={row.montage} className="border-b"><th scope="row" className="py-1 font-normal">{row.montage}</th><td>{row.detected}/{row.events}</td><td>{row.falseRate.toFixed(2)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <p className="text-muted-foreground">These measurements use research montages. Bedside alarm performance and accuracy on the intended headband require separate testing.</p>
        </section>
        <a href={report} target="_blank" rel="noreferrer" className="underline">Methods, uncertainty intervals, external cohorts and fitted models</a>
      </CardContent>
    </Card>
  );
}
