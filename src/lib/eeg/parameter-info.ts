/**
 * Clinician-facing explanations for every parameter the monitor displays.
 * Each entry covers what the number means, the underlying neurophysiology,
 * how far it can be trusted from a 4-electrode frontal montage (Muse 2),
 * and the typical range clinicians should expect.
 */
export interface ParameterInfo {
  title: string;
  /** One-line plain-language summary. */
  summary: string;
  /** Why it matters clinically. */
  significance: string;
  /** Underlying physiology / signal origin. */
  physiology: string;
  /** Reliability, pitfalls and confounders. */
  reliability: string;
  /** Typical or target range, when one exists. */
  range?: string;
}

export type ParameterInfoKey =
  | "depth"
  | "sr"
  | "suppressionTime"
  | "seizure"
  | "sef95"
  | "amplitude"
  | "entropy"
  | "deltaAlpha"
  | "betaAlpha"
  | "cIndex"
  | "nIndex"
  | "sqi"
  | "confidence"
  | "dsa"
  | "ce";

export const PARAMETER_INFO: Record<ParameterInfoKey, ParameterInfo> = {
  depth: {
    title: "Depth index (OpenIBIS)",
    summary:
      "0–100 processed-EEG index of hypnotic depth, computed with the open OpenIBIS algorithm.",
    significance:
      "Guides titration of hypnotic agent: values around 40–60 correspond to general anaesthesia with a low probability of awareness, >60 suggests light anaesthesia or arousal risk, and <40 indicates deeper-than-necessary suppression associated with haemodynamic instability and, in frail patients, delirium.",
    physiology:
      "As hypnotics increase GABA-A inhibition, thalamocortical loops slow: high-frequency cortical activity falls, delta/alpha power rises and frontal alpha becomes coherent. OpenIBIS combines a burst-suppression term, a time-domain/bicoherence-derived synch-fast-slow term and the beta ratio, mixing them on a sigmoid scale that tracks the commercial BIS closely (published agreement ~±10 units).",
    reliability:
      "Frontal EMG, eye movements, diathermy and electrode movement all inflate the index; ketamine, nitrous oxide and dexmedetomidine break the usual dose–index relationship. There is a 15–30 s processing lag, so it lags rapid boluses. The tile is marked Unreliable or Degraded and held at the last valid value when artefact gating triggers — never titrate on a held or low-confidence number alone.",
    range: "Target 40–60 for general anaesthesia; >60 light; <40 deep.",
  },
  sr: {
    title: "Suppression ratio (BSR)",
    summary: "Percentage of the recent window in which the EEG is isoelectric (suppressed).",
    significance:
      "Any sustained suppression during routine anaesthesia usually means excess hypnotic for that patient's brain. Prolonged burst suppression is associated with postoperative delirium and, on ICU, with worse outcome — unless suppression is a deliberate therapeutic target (refractory status epilepticus, raised ICP).",
    physiology:
      "Deep cortical inhibition, hypothermia, hypoxic-ischaemic injury or metabolic failure produce alternating bursts of high-amplitude mixed-frequency activity and near-flat periods, reflecting failure of cortical neurons to sustain background firing between synchronised bursts.",
    reliability:
      "Suppression is detected when signal amplitude stays under the configured microvolt floor for a minimum duration, so a low-amplitude but clean EEG in an elderly or hypothermic patient can look suppressed, while continuous EMG or mains noise masks true suppression and under-reads BSR. Frontal electrodes may miss regional suppression. Confirm against the raw waveform strip before acting.",
    range: "0 % in most maintenance anaesthesia; >5 % sustained warrants review.",
  },
  suppressionTime: {
    title: "Suppression time",
    summary: "Cumulative time spent in suppression during this case.",
    significance:
      "Total dose-time of suppression matters more than any single BSR reading: cumulative burst-suppression minutes track with postoperative delirium risk and are a useful handover and audit figure.",
    physiology:
      "Integrates each detected suppressed epoch. It reflects the total period of profound cortical inhibition, whether drug-induced, from hypoperfusion/hypoxia, or from the underlying brain injury.",
    reliability:
      "Inherits every limitation of the suppression ratio: amplitude thresholds, low-voltage baselines, and artefact-masked suppression. Periods of poor signal quality or disconnection are not counted, so this figure is a lower bound when coverage was incomplete.",
  },
  seizure: {
    title: "Seizure score",
    summary:
      "0–1 likelihood that the current epoch contains rhythmic, evolving, seizure-like activity.",
    significance:
      "Non-convulsive seizures and non-convulsive status are common and easily missed in sedated ICU patients and after cardiac arrest; a rising score should prompt review of the raw EEG and, if sustained, formal multichannel EEG. In anaesthesia mode the same score runs as a lower-sensitivity background watch.",
    physiology:
      "Seizures produce hypersynchronous neuronal firing that shows as narrow-band rhythmic discharges with increasing amplitude and evolving frequency. The score combines spectral peak sharpness, rhythmicity, amplitude escalation and temporal evolution against the configured sensitivity preset.",
    reliability:
      "This is a screening aid, not a diagnosis. A 4-electrode frontal montage cannot localise or exclude temporal/occipital-onset seizures, and rhythmic artefact (chest physiotherapy, shivering, ventilator, tremor, chewing) is the commonest cause of a false positive. Sedation and burst suppression blunt true positives. Always correlate with the waveform, markers and clinical picture.",
    range:
      "Alert threshold is set by the active sensitivity preset (ICU is more sensitive than anaesthesia).",
  },
  sef95: {
    title: "Spectral edge frequency 95 (SEF95)",
    summary: "The frequency below which 95 % of total EEG power lies.",
    significance:
      "A simple, transparent depth surrogate: SEF95 falls as anaesthesia deepens and rises with lightening or arousal, often before the composite index moves. Useful when a proprietary index is confounded (e.g. ketamine).",
    physiology:
      "Anaesthetic-induced thalamocortical hyperpolarisation shifts power from beta/gamma to alpha and delta, dragging the spectral edge downward. Encephalopathy and ischaemia shift it down the same way, without the frontal alpha spindle.",
    reliability:
      "Very sensitive to high-frequency contamination — frontal EMG, diathermy and mains noise all push SEF95 artefactually upward; a suppressed EEG can produce erratic values because there is little power to distribute. Interpret alongside the DSA rather than as a stand-alone number.",
    range: "Roughly 8–13 Hz in surgical anaesthesia; 15–25 Hz awake/light.",
  },
  amplitude: {
    title: "Amplitude (peak-to-peak)",
    summary: "Largest peak-to-peak deflection in the current epoch, in microvolts.",
    significance:
      "The main sanity check on the whole display: physiological scalp EEG is tens of microvolts. Very high values mean movement, diathermy or a loose electrode; very low values mean suppression, a flat/off electrode, or a very low-voltage record.",
    physiology:
      "Scalp amplitude reflects synchronised postsynaptic potentials from large cortical populations, attenuated by skull and scalp. Synchrony (deep anaesthesia, slow-wave activity) raises it; desynchronised awake activity and cortical suppression lower it.",
    reliability:
      "The most artefact-prone parameter shown, and the one that drives the suppression detector's amplitude floor. Blink and muscle artefact routinely exceed 200 µV. Check electrode contact whenever amplitude is implausibly high or near zero.",
    range:
      "Typically 20–100 µV under anaesthesia; <10 µV suggests suppression or electrode failure.",
  },
  entropy: {
    title: "Spectral entropy",
    summary:
      "Normalised Shannon entropy of the power spectrum — how disordered/broadband the EEG is.",
    significance:
      "Entropy falls with deepening anaesthesia and is a drug-independent, algorithmically transparent depth marker. The state value uses the lower-frequency band; the response value extends into the EMG band, so a widening state–response gap suggests nociception or impending arousal.",
    physiology:
      "Wakeful cortex generates broadband, unpredictable activity (high entropy). Anaesthesia concentrates power into narrow slow and alpha peaks, making the spectrum more ordered and lowering entropy; suppression drives it lowest.",
    reliability:
      "Any narrow-band artefact (50/60 Hz mains, ventilator rhythm) falsely lowers entropy; EMG raises the response value in particular. Values are unstable when total power is very low, i.e. during suppression, and the tile is confidence-weighted for that reason.",
    range: "≈0.9–1.0 awake, 0.4–0.7 surgical anaesthesia, <0.3 deep/suppressed.",
  },
  deltaAlpha: {
    title: "Delta / alpha ratio",
    summary: "Ratio of slow (0.5–4 Hz) to alpha (8–13 Hz) power.",
    significance:
      "A recognised marker of cortical slowing. A high or rising ratio suggests deepening anaesthesia, encephalopathy, hypoperfusion/ischaemia or hypoxic brain injury; in ICU it is one of the better single-number markers of delirium risk and of change in cerebral state.",
    physiology:
      "Frontal alpha depends on intact thalamocortical loops; delta arises from cortical and thalamic slow oscillations that dominate when those loops are disrupted by drugs, ischaemia or metabolic failure. Loss of alpha with preserved delta gives a rising ratio.",
    reliability:
      "Reference ranges are age-dependent — elderly patients show less frontal alpha even at appropriate depth, so trends within a patient are more informative than absolute values. Eye movement and sweat artefact add spurious delta; ketamine and dexmedetomidine alter the ratio in drug-specific ways.",
  },
  betaAlpha: {
    title: "Beta / alpha ratio",
    summary: "Ratio of fast (13–30 Hz) to alpha (8–13 Hz) power.",
    significance:
      "Rises with light anaesthesia, arousal and inadequate hypnosis, and with benzodiazepine or low-dose volatile 'beta buzz'. A sudden rise during surgery should prompt a check for lightening before it becomes movement or recall.",
    physiology:
      "Beta activity reflects desynchronised, activated cortex and GABA-A-mediated fast activity at subhypnotic drug concentrations; alpha dominates once stable anaesthetic thalamocortical coupling is established.",
    reliability:
      "Frontal EMG overlaps the beta band and is the main confounder — a paralysed patient's ratio behaves quite differently from an unparalysed one. Interpret alongside the depth index and the DSA rather than in isolation.",
  },
  cIndex: {
    title: "Consciousness index (qCON-like)",
    summary:
      "0–99 composite of hypnotic state built from fast/slow balance, entropy and suppression.",
    significance:
      "A second, independently derived opinion on hypnotic depth to cross-check the OpenIBIS depth index. Agreement between the two increases confidence; divergence usually flags artefact or an atypical drug regimen.",
    physiology:
      "Combines the same physiology as its inputs — loss of high-frequency power, emergence of coherent frontal alpha, rising entropy order and cortical suppression as anaesthesia deepens — into a single sigmoid-scaled index.",
    reliability:
      "This is a qCON-like reimplementation, not the validated commercial qCON monitor, and is not certified for clinical decision-making. It is held during artefact and shares every confounder of its inputs (EMG, ketamine, low-voltage records).",
    range: "≈60–80 adequate hypnosis; >80 light; <40 deep.",
  },
  nIndex: {
    title: "Nociception index (qNOX-like)",
    summary: "0–99 composite estimating the probability of a response to a noxious stimulus.",
    significance:
      "Helps balance analgesia against hypnosis: a high value with an adequate depth index suggests under-analgesia rather than light hypnosis, and predicts movement or haemodynamic response to surgical stimulus.",
    physiology:
      "Nociceptive input reaches cortex via ascending arousal pathways, producing subtle high-frequency drive, increased EEG reactivity and a widening state–response entropy gap even while the hypnotic component is stable.",
    reliability:
      "Nociception indices are inherently weaker than hypnotic indices, and this is an unvalidated qNOX-like reimplementation. Neuromuscular blockade removes the EMG contribution and can make the value look falsely reassuring. Use as a trend adjunct alongside haemodynamics and clinical judgement.",
    range: "≈40–60 adequate analgesia; >60 suggests risk of response.",
  },
  sqi: {
    title: "Signal quality (per hemisphere)",
    summary:
      "Composite electrode-pair quality score: contact, noise, clipping, movement and dropout.",
    significance:
      "Every number on this screen is only as good as the signal underneath it. Grade good/fair/poor tells you at a glance whether the corresponding DSA lane and metrics can be trusted, and which side needs an electrode check.",
    physiology:
      "Reflects skin–electrode impedance and mechanical contact rather than brain activity. Poor contact adds mains pickup and drift; movement adds low-frequency swing; jaw and forehead muscle add broadband EMG above ~30 Hz.",
    reliability:
      "The score is derived from the signal itself, not from a true impedance measurement, so a flat disconnected channel can occasionally look 'quiet' rather than bad — this is why a separate flat/no-signal state exists. Reposition, moisten and reseat electrodes rather than accepting a poor grade.",
    range: "Good >75 %, fair 45–75 %, poor <45 %.",
  },
  confidence: {
    title: "Confidence",
    summary: "How much the live signal quality supports the displayed metric.",
    significance:
      "Converts artefact into an explicit trust level per metric, so you can tell a genuine clinical change from a data-quality change. Low confidence means treat the number as a hypothesis and look at the raw trace.",
    physiology:
      "Not a physiological measure: it weights clipping, EMG band power, movement artefact, dropout and epoch coverage for the electrodes feeding that metric.",
    reliability:
      "Confidence is a heuristic, not a validated probability. High confidence does not exclude drug-specific misinterpretation (ketamine, dexmedetomidine) or the limits of a frontal montage — it only says the input signal was clean.",
    range: "High >75 %, moderate 45–75 %, low <45 %.",
  },
  dsa: {
    title: "Density spectral array (DSA)",
    summary: "Colour heat map of EEG power at each frequency (y-axis) over time (x-axis).",
    significance:
      "The single most information-dense display here: it shows anaesthetic state, trends and events at a glance. A stable alpha band (8–13 Hz) with delta below it is the classic 'anaesthetic ridge'; loss of alpha means too deep or an injured/elderly brain, an upward drift means lightening, dark vertical columns mean suppression, and left–right asymmetry can indicate unilateral pathology.",
    physiology:
      "Each column is a short-time power spectrum from a Welch-averaged FFT of the raw EEG. Colour encodes power in decibels, so the map directly visualises the shift of cortical rhythms between delta, theta, alpha and beta bands as thalamocortical dynamics change.",
    reliability:
      "Muse 2 is a 4-electrode frontal montage: it cannot show posterior or temporal activity, cannot localise focal pathology and only approximates hemispheric difference (left TP9+AF7, right AF8+TP10). Broad vertical stripes across all frequencies are almost always artefact rather than a brain event. Interpret asymmetry cautiously and confirm with formal EEG.",
  },
  ce: {
    title: "Effect-site concentration (Ce)",
    summary: "Model-predicted drug concentration at the effect site from the running TCI pump(s).",
    significance:
      "Lets the EEG response be read against dosing: pairing Ce changes with depth, suppression and spectral trends shows whether the brain is responding as the model predicts, and highlights unusually sensitive or resistant patients.",
    physiology:
      "Ce is a pharmacokinetic-pharmacodynamic estimate, not a measurement. Eleveld models transfer plasma concentration into a hypothetical effect compartment with a rate constant (ke0) so that predicted concentration tracks the observed EEG effect with the correct hysteresis.",
    reliability:
      "Model output only — real concentrations vary widely with age, obesity, cardiac output, hepatic/renal function, blood loss and drug interactions, and values entered by hand are only as accurate as the entry. Treat the EEG as the measurement and Ce as the covariate, not the other way round.",
  },
};
