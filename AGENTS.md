<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Research-integrity rules (EEG)

- Uncalibrated amplitude (`calibratedAmplitude: false`) withholds COEBIS-2 and every µV-dependent output (suppression, PTP); store and pass NULL with a reason, never 0 — absolute features are invalid on an unknown scale.
- Never score a waveform-trained model from spectrum-only stored data with substituted inputs; return an explicit unavailable result listing missing inputs.
- Harmonisation records the source reference and passband only; it never applies gains, never infers an average reference from "-REF", and leaves unsupported bands unavailable. New fits must pass `isHarmonizationFitCompatible` (legacy records stay stored but excluded until reprocessed).
- Disease targets come only from explicit confirmed diagnoses with provenance; dataset categories (`pathology_category`, etc.) are descriptors, never targets. Diagnosis output is exploratory and uncalibrated.
- The AI reviewer explains supplied metrics only; `guardInterpretation` enforces no treatment directives, no awareness/diagnostic claims, digest-verified numbers, and missingness. Clinician feedback is stored for offline review and never tunes alerts.
- Models, calibrations and tunes are frozen for a recording (`model-freeze.ts`); changes queue to the next recording and provenance is saved with the case.
- Validation wording comes from `validation-registry.ts`; synthetic regression checks are never presented as human validation, and BIS agreement is never presented as outperforming BIS.
