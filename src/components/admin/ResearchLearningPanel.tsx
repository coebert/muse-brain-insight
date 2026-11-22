import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RESEARCH_SCORE_NOTE } from "@/lib/eeg/descriptor-only";
import blockade from "@/lib/eeg/research-blockade.json";
import learning from "@/lib/eeg/research-waveform-learning.json";

const report = "https://github.com/coebert/muse-brain-insight/blob/research/eeg-baselines/research/learning/README.md";

export function ResearchLearningPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Anaesthesia, neuromuscular blockade and seizure research</CardTitle>
        <CardDescription>
          Retrospective tests on recorded EEG, 21 November 2026. Research descriptors only — not
          a clinical depth measurement and not for clinical use.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <section className="space-y-2">
          <h3 className="font-medium">Awake during neuromuscular blockade</h3>
          <p>One participant at a time was held out while a model learned from the other five. The model used frontal alpha power relative to each person’s awake baseline. It classified {blockade.falseSedated} of {blockade.volunteers} awake, paralysed volunteers as sedated.</p>
          <p>This is a frontal-alpha comparator, distinct from the propofol protocol-state classifier below and from the surgical EMG model. None of the three is a consciousness monitor. The offline replay fails closed: absent, unknown, conflicting, mixed, expired or incompletely evidenced blockade context withholds the depth statement, and the app withholds the experimental depth index, target and alerts unless a matched, fully documented absence of blockade is attached.</p>
          <p>In a separate surgical dataset, {blockade.surgicalCases} cases contributed {blockade.windows} usable EEG windows around a volume-confirmed rocuronium infusion change. Awareness was unlabelled, and the monitor EMG target shares the EEG electrodes.</p>
          <p className="text-muted-foreground">Independent validation requires native waveform EEG from a different cohort, with montage, reference, calibration and medication timing available for reprocessing. Published summary figures, screenshots and repeated playbacks of one volunteer are not independent validation. No independent clinical validation is claimed.</p>
          <a className="underline" href="https://github.com/coebert/muse-brain-insight/blob/research/eeg-baselines/research/learning/neuromuscular-blockade.md" target="_blank" rel="noreferrer">Blockade studies, waveform access and failure analysis</a>
        </section>
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
          <p className="text-muted-foreground">Behavioural task performance and reported awareness are different endpoints. The report includes a separate analysis of correct responses. An eligible offline replay score names its model (propofol-protocol-state, version 1) and marks itself research-only; it is never a clinical depth.</p>
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
        <p className="text-xs text-muted-foreground">{RESEARCH_SCORE_NOTE}</p>
      </CardContent>
    </Card>
  );
}
