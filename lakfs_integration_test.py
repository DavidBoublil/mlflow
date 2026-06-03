# %% [markdown]
# # lakFS Integration Test
#
# Populates a local MLflow tracking server with sample data: an experiment,
# several runs with parameters / metrics / tags / artifacts, and a logged
# scikit-learn model. Tags simulate a lakeFS-versioned data pipeline (repo,
# branch, commit) so the runs are reproducible against a specific data commit.
#
# Run as a script (`python lakfs_integration_test.py`) or cell-by-cell in
# Jupyter. Requires a tracking server reachable at TRACKING_URI.

# %%
import random
import tempfile
from pathlib import Path

import matplotlib.pyplot as plt
import mlflow
import numpy as np
import pandas as pd
from mlflow.models import infer_signature
from sklearn.datasets import make_classification
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split

TRACKING_URI = "http://127.0.0.1:5000"
EXPERIMENT_NAME = "lakfs_integration_test"

# Simulated lakeFS data versioning coordinates. In a real pipeline these would
# come from the lakeFS commit the training data was read from.
LAKEFS_REPO = "ml-training-data"
LAKEFS_BRANCH = "main"


def fake_commit_id(seed: int) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice("0123456789abcdef") for _ in range(40))


# %%
mlflow.set_tracking_uri(TRACKING_URI)
experiment_id = mlflow.set_experiment(EXPERIMENT_NAME).experiment_id
print(f"Tracking URI : {mlflow.get_tracking_uri()}")
print(f"Experiment   : {EXPERIMENT_NAME} (id={experiment_id})")

# %%
# Shared synthetic dataset (stands in for data read from a lakeFS commit).
X, y = make_classification(
    n_samples=2000,
    n_features=20,
    n_informative=8,
    n_classes=2,
    random_state=42,
)
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=42)

# %%
# Sweep over a few hyperparameter configs; each becomes an MLflow run.
configs = [
    {"n_estimators": 50, "max_depth": 4},
    {"n_estimators": 100, "max_depth": 8},
    {"n_estimators": 200, "max_depth": 12},
    {"n_estimators": 300, "max_depth": None},
]

best_f1 = -1.0
best_run_id = None

for i, cfg in enumerate(configs):
    commit = fake_commit_id(i)
    with mlflow.start_run(run_name=f"rf-sweep-{i}") as run:
        # Parameters
        mlflow.log_params(cfg)
        mlflow.log_param("test_size", 0.25)

        # Tags: simulate a lakeFS-pinned data version for reproducibility.
        mlflow.set_tags(
            {
                "lakefs.repo": LAKEFS_REPO,
                "lakefs.branch": LAKEFS_BRANCH,
                "lakefs.commit": commit,
                "lakefs.data_uri": f"lakefs://{LAKEFS_REPO}/{commit}/datasets/train.parquet",
                "framework": "scikit-learn",
            }
        )

        model = RandomForestClassifier(random_state=42, **cfg)

        # Log a simple "training curve" so the UI has stepped metrics to plot.
        for n in range(10, cfg["n_estimators"] + 1, max(cfg["n_estimators"] // 10, 1)):
            partial = RandomForestClassifier(
                n_estimators=n, max_depth=cfg["max_depth"], random_state=42
            ).fit(X_train, y_train)
            step_acc = accuracy_score(y_test, partial.predict(X_test))
            mlflow.log_metric("val_accuracy", step_acc, step=n)

        model.fit(X_train, y_train)
        preds = model.predict(X_test)
        acc = accuracy_score(y_test, preds)
        f1 = f1_score(y_test, preds)
        mlflow.log_metrics({"accuracy": acc, "f1": f1})

        # Artifact 1: a metrics CSV.
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            csv_path = tmp_path / "metrics.csv"
            pd.DataFrame([{"accuracy": acc, "f1": f1, **cfg}]).to_csv(csv_path, index=False)
            mlflow.log_artifact(csv_path, artifact_path="reports")

            # Artifact 2: a feature-importance plot.
            fig, ax = plt.subplots(figsize=(8, 4))
            importances = model.feature_importances_
            ax.bar(range(len(importances)), importances)
            ax.set_title(f"Feature importances (run {i})")
            ax.set_xlabel("feature index")
            ax.set_ylabel("importance")
            plot_path = tmp_path / "feature_importance.png"
            fig.tight_layout()
            fig.savefig(plot_path)
            plt.close(fig)
            mlflow.log_artifact(plot_path, artifact_path="plots")

        # Log the model itself (shows up in the run's Artifacts + Models tab).
        signature = infer_signature(X_test, preds)
        mlflow.sklearn.log_model(
            model,
            name="model",
            signature=signature,
            input_example=X_test[:5],
        )

        print(f"run {i}: acc={acc:.4f} f1={f1:.4f} commit={commit[:8]} -> {run.info.run_id}")

        if f1 > best_f1:
            best_f1 = f1
            best_run_id = run.info.run_id

# %%
print(f"\nBest run: {best_run_id} (f1={best_f1:.4f})")
print(f"Open the UI at {TRACKING_URI} and look at the '{EXPERIMENT_NAME}' experiment.")
