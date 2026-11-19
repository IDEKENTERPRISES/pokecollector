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

# Version 15 test (option ``serverocr``): the PP-OCRv4 *server* text detector and recogniser (PaddleOCR, Apache-2.0) in the
# ONNX conversion RapidOCR's author publishes (SWHL/RapidOCR on Hugging Face, Apache-2.0), pinned to a repository commit.
# They load in ``rapidocr-onnxruntime==1.3.24`` unchanged: the recogniser carries its 6,623-character list in the ONNX metadata
# (``character``), so no dictionary file is needed. Fetched at image build time like the picture models; the second engine is
# only ever built when a matcher with ``serverocr`` runs. PP-OCRv5 server models were not used (they need a newer RapidOCR).
_OCR_SERVER_COMMIT = "1cfba2e90fc938db55889873735088de210cc173"
OCR_MODEL_SPECS = {
    "ocr-server-det": {
        "url": f"https://huggingface.co/SWHL/RapidOCR/resolve/{_OCR_SERVER_COMMIT}/PP-OCRv4/ch_PP-OCRv4_det_server_infer.onnx",
        "sha256": "cfa39a3f298f6d3fc71789834d15da36d11a6c59b489fc16ea4733728012f786",
        "filename": "ch_PP-OCRv4_det_server_infer.onnx",
        "size_bytes": 113352104,
        "license": "Apache-2.0",
        "source": "https://huggingface.co/SWHL/RapidOCR",
    },
    "ocr-server-rec": {
        "url": f"https://huggingface.co/SWHL/RapidOCR/resolve/{_OCR_SERVER_COMMIT}/PP-OCRv4/ch_PP-OCRv4_rec_server_infer.onnx",
        "sha256": "6a2676219be9907c7fc9cf61ebaa843bf2898777def567925b78886fcd90c07a",
        "filename": "ch_PP-OCRv4_rec_server_infer.onnx",
        "size_bytes": 90530732,
        "license": "Apache-2.0",
        "source": "https://huggingface.co/SWHL/RapidOCR",
    },
}
