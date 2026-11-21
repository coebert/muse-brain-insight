"""Regenerate the aggregate transfer and event-sensitivity figure."""

from pathlib import Path
import json
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def draw(folder):
    st = json.loads((folder / "propofol-transfer-results.json").read_text())
    sz = json.loads((folder / "neonatal-results.json").read_text())
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8), layout="constrained")
    colors = ["#007d79", "#374d73"]
    offsets = [0.10, -0.10]
    for i, m in enumerate(["frontal", "broader"]):
        label = "Two frontal" if not i else "Broader montage"
        for j, d in enumerate(["cambridge_to_oslo", "oslo_to_cambridge"]):
            a = st[m][d]["AUROC"]
            v = a["value"]
            lo, hi = a["interval"]
            axes[0].errorbar(
                v,
                j + offsets[i],
                xerr=[[max(0, v - lo)], [max(0, hi - v)]],
                capsize=3,
                fmt="o",
                color=colors[i],
                label=label if j == 0 else None,
            )
        for j, kind in enumerate(["linear", "boosted"]):
            a = sz[m][kind]
            v = a["event_sensitivity"]
            lo, hi = a["event_sensitivity_patient_bootstrap_95"]
            axes[1].errorbar(
                v,
                j + offsets[i],
                xerr=[[max(0, v - lo)], [max(0, hi - v)]],
                capsize=3,
                fmt="o",
                color=colors[i],
            )
    axes[0].axvline(0.5, color="#93989b", ls="--", lw=1)
    axes[0].set(
        title="Propofol protocol state",
        xlabel="External AUROC",
        yticks=[0, 1],
        yticklabels=["Cambridge → Oslo", "Oslo → Cambridge"],
    )
    axes[1].set(
        title="Neonatal seizure events",
        xlabel="Fraction detected",
        yticks=[0, 1],
        yticklabels=["Linear", "Boosted trees"],
    )
    for ax in axes:
        ax.set(xlim=(-0.02, 1.02), ylim=(1.45, -0.45))
        ax.grid(axis="x", color="#dfE4e7", lw=0.6)
        for edge in ("top", "right", "left"):
            ax.spines[edge].set_visible(False)
        ax.tick_params(axis="y", length=0)
        ax.set_axisbelow(True)
    axes[0].legend(loc="lower left", frameon=False, fontsize=8)
    fig.savefig(folder / "waveform-learning.png", dpi=160, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    draw(Path(__file__).parent / "results")
