# MindGuard EEG multilingual search and arousal research

21 November 2026

The [source catalogue](../research/eeg/source-catalogue.csv) now has 208 entries. Entries EEG-195–208 came from a multilingual search with priority given to Chinese institutional search terms and local repositories. The search included simplified and traditional Chinese, Korean, Japanese, French, Spanish, Portuguese, German and Polish. Positive findings include 10 mainland Chinese records and four records from South Korea, Japan–US, France and Spain. Three Chinese entries are registry leads without confirmed waveform deposits. The remaining entries have recordings or a public BIDS archive listed by their provider, with availability and rights entered in the catalogue. The earlier Dryad microstate entry (EEG-051) was reclassified as derived data after checking the linked file inventory.

## Clinical priorities

- Zhejiang clinical epilepsy EEG lists 367 hours of scalp data and 680 hours of cortical data collected. The portal describes annotated seizure timing and focal channels. Release requires approval. Request a concrete file manifest, patient and session counts, and permission for the intended use. [National data catalogue](https://www.nbsdc.cn/general/dataDetail?id=61e6284399f1de374f16a3cd&type=1)
- For depth monitoring, the three Chinese trial records cover paediatric propofol versus sevoflurane, intraoperative IV drug comparisons and a propofol versus physiological sleep comparison. They are collaboration leads. [Paediatric registry](https://www.chictr.org.cn/hvshowproject.html?id=280685&v=1.0) · [IV-agent registry](https://www.chictr.org.cn/showproj.html?proj=213238) · [Sleep comparator registry](https://www.chictr.org.cn/showprojEN.html?proj=222830)
- The CC0 Madrid resting EEG and CC BY Zhejiang walking recordings offer two distinct robustness tests. The first isolates eyes-open versus eyes-closed state and the second characterises motion and stimulus interference. [Madrid](https://www.nemar.org/dataset/on007987) · [Zhejiang](https://doi.org/10.57760/sciencedb.0145k)

## Model fit and held-out test

Southwest University ds004902 v1.0.8 supplies matched eyes-open EEG following normal sleep and sleep deprivation. Both sessions from each participant stayed together during the single, order-stratified development/test split. The model uses fixed features from the same six bipolar derivations as the disease-discovery study. Up to 48 seconds per record were offered to the extractor after the initial two seconds. Among 71 participants, 66 supplied both usable sessions, giving 132 recordings and 6,260 analysed seconds. Three pairs were excluded for waveform length versus header mismatch, and two for sample-rate or montage incompatibility. A fixed logistic regression and scaling pipeline was fitted on 46 pairs. Twenty untouched participant pairs were used to evaluate all three prespecified feature sets. [Deposit](https://doi.org/10.18112/openneuro.ds004902.v1.0.8) · [Publisher](https://doi.org/10.1038/s41597-024-03268-2)

| Research baseline | Held-out AUROC | 95% paired bootstrap interval | Pairs ranked correctly |
| --- | ---: | ---: | ---: |
| Standard multichannel spectral features | 0.55 | 0.40–0.70 | 12/20 |
| Extended frontal features | 0.59 | 0.39–0.79 | 11/20 |
| Extended multichannel features | 0.66 | 0.49–0.83 | 13/20 |

The intervals are wide and cover chance for all three feature sets. The frontal result provides the more relevant starting point for a reduced-montage device. This study uses healthy volunteers and a sleep-deprivation exposure. It supplies neither behavioural responsiveness labels under anaesthesia nor clinical disease labels.

## Existing Parkinson’s score stress test

The previously fitted Parkinson’s research score was held fixed. Its logit rose after sleep deprivation in 46 of 66 healthy volunteers, with a median within-person rise of 0.55 (IQR −0.25 to +1.97, paired Wilcoxon p = 0.0017). This is evidence of sensitivity to a state change in this dataset. The Parkinson’s model previously reached AUROC 0.49 in an independent cohort and the stress test establishes neither diagnostic accuracy nor a clinically meaningful threshold. Lock an arousal challenge into future evaluation and check the effect in independent sites and in the intended device montage.

The [code](../research/discovery/arousal.py), [results and fitted coefficients](eeg-arousal-results.json) and [successful workflow](https://github.com/coebert/muse-brain-insight/actions/runs/44914162341) are on the research branch. The app’s Admin Training screen displays the retrospective results. The weights are retained for offline reproduction. Clinical runtime inference was not updated.
