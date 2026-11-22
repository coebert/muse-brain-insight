"""Retrieve public metadata for the pinned releases used by the age analysis."""

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pandas as pd
import requests
from age_extract import RELEASES


def fetch(url, path):
    if path.exists():
        return
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            path.write_bytes(r.content)
            return
        except requests.RequestException:
            if attempt == 2:
                raise


def main():
    root = Path("age-meta")
    root.mkdir(exist_ok=True)
    jobs = []
    for ds, release in RELEASES.items():
        base = f"https://raw.githubusercontent.com/OpenNeuroDatasets/{ds}/{release}"
        for name in ["participants.tsv", "participants.json", "dataset_description.json"]:
            fetch(f"{base}/{name}", root / f"{ds}-{name}")
        fetch(
            f"https://api.github.com/repos/OpenNeuroDatasets/{ds}/git/trees/{release}?recursive=1",
            root / f"{ds}-tree.json",
        )
        if ds == "ds005385":
            people = pd.read_csv(root / f"{ds}-participants.tsv", sep="\t")
            for pid in people.loc[people.session2 == "yes", "participant_id"]:
                jobs.append((f"{base}/{pid}/{pid}_sessions.tsv", root / f"{pid}-sessions.tsv"))
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda pair: fetch(*pair), jobs))


if __name__ == "__main__":
    main()
