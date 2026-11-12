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
    "dinov2-small-int8": {
        # Version 11 (phone settings): the 8-bit quantised export of the same model, as the iPhone would load it
        # (24 MB against 88 MB). Same repository commit as ``dinov2-small``; the file is ``onnx/model_int8.onnx``
        # (``model_quantized.onnx`` and ``model_uint8.onnx`` are the same size and a different, identical-to-each-other file).
        "url": "https://huggingface.co/onnx-community/dinov2-small/resolve/"
               "8b1f705a3a7f6f062f6bdd21986c1583d3ef105d/onnx/model_int8.onnx",
        "sha256": "dfce54a839b491f395c516350ebb4a78f947e9170a6beac0f2bc5638e0f09d61",
        "filename": "dinov2-small-int8.onnx",
        "size_bytes": 24446700,
        "dim": 384,
        "input_size": 224,
        "mean": (0.485, 0.456, 0.406),
        "std": (0.229, 0.224, 0.225),
        "output": "cls",
        "license": "Apache-2.0",
        "source": "https://huggingface.co/onnx-community/dinov2-small",
    },
    "dinov2-small-fp16": {
        # The half-precision export (44 MB): a middle option if int8 loses too much on real photos.
        "url": "https://huggingface.co/onnx-community/dinov2-small/resolve/"
               "8b1f705a3a7f6f062f6bdd21986c1583d3ef105d/onnx/model_fp16.onnx",
        "sha256": "16845e153bbaf3fd1ef8a2154c454940f901f6fe8a80dd4c6c319eaecdb4d2ee",
        "filename": "dinov2-small-fp16.onnx",
        "size_bytes": 44420939,
        "dim": 384,
        "input_size": 224,
        "mean": (0.485, 0.456, 0.406),
        "std": (0.229, 0.224, 0.225),
        "output": "cls",
        "license": "Apache-2.0",
        "source": "https://huggingface.co/onnx-community/dinov2-small",
    },
    "dinov2-base": {
        # DINOv2 ViT-B/14 (Meta AI, Apache-2.0), same export and layout as the small one, 768 numbers per
        # picture. Pinned to a repository commit. A second index for the benchmark comparison (a bigger model
        # recognises reprints better, at about four times the time per picture).
        "url": "https://huggingface.co/onnx-community/dinov2-base/resolve/"
               "31ef06cac16d5d301c5930d147002a058c85a5e4/onnx/model.onnx",
        "sha256": "320d1012a6fc65b101fc85ca30ee7a47b2e4f6a2e8bd78fb9d7036def0e30cb0",
        "filename": "dinov2-base.onnx",
        "size_bytes": 346627111,
        "dim": 768,
        "input_size": 224,
        "mean": (0.485, 0.456, 0.406),
        "std": (0.229, 0.224, 0.225),
        "output": "cls",
        "license": "Apache-2.0",
        "source": "https://huggingface.co/onnx-community/dinov2-base",
    },
}
