"""Pinned model files. Standard library only: the Dockerfile runs ``scripts/fetch_card_match_models.py``
(which reads this file) at build time, so the image has the models and nothing downloads at runtime.

``sha256`` is checked after the download and again before a model is first loaded.
"""

DEFAULT_MODEL = "dinov2-small"

MODEL_SPECS = {
    "dinov2-small": {
        # DINOv2 ViT-S/14 (Meta AI, Apache-2.0), ONNX export by onnx-community (Transformers.js), fp32.
        # Pinned to a repository commit so the URL cannot change under us.
        "url": "https://huggingface.co/onnx-community/dinov2-small/resolve/"
               "8b1f705a3a7f6f062f6bdd21986c1583d3ef105d/onnx/model.onnx",
        "sha256": "f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a",
        "filename": "dinov2-small.onnx",
        "size_bytes": 88532934,
        "dim": 384,
        "input_size": 224,
        "mean": (0.485, 0.456, 0.406),
        "std": (0.229, 0.224, 0.225),
        "output": "cls",  # last_hidden_state[:, 0]
        "license": "Apache-2.0",
        "source": "https://huggingface.co/onnx-community/dinov2-small",
    },
}
