# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Load Ardy diffusion models from local checkpoints or Hugging Face."""

from pathlib import Path
from typing import Optional

import torch
from huggingface_hub import snapshot_download
from omegaconf import OmegaConf

from .loading import (
    DEFAULT_MODEL,
    DEFAULT_TEXT_ENCODER_URL,
    get_env_var,
    instantiate_from_dict,
)
from .registry import hf_repo_id, resolve_model_name

DEFAULT_TEXT_ENCODER = "llm2vec"
TEXT_ENCODER_PRESETS = {
    "llm2vec": {
        "target": "ardy.model.LLM2VecEncoder",
        "kwargs": {
            "base_model_name_or_path": "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp",
            "peft_model_name_or_path": "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised",
            "dtype": "bfloat16",
            "llm_dim": 4096,
            "device": "auto",
        },
    }
}


def _download_from_hf(full_name: str) -> Path:
    """Download a released model from Hugging Face; returns the local snapshot dir.

    With LOCAL_CACHE=true, tries the local HF cache first and falls back online.
    """
    repo_id = hf_repo_id(full_name)
    local_cache = get_env_var("LOCAL_CACHE", "False").lower() == "true"
    if local_cache:
        try:
            return Path(snapshot_download(repo_id=repo_id, local_files_only=True))
        except Exception:
            pass  # cache miss -> download online below
    return Path(snapshot_download(repo_id=repo_id))


def _build_api_text_encoder_conf(text_encoder_url: str) -> dict:
    return {
        "_target_": "ardy.model.text_encoder_api.TextEncoderAPI",
        "url": text_encoder_url,
    }


def _build_local_text_encoder_conf(text_encoder_fp32: bool = False) -> dict:
    text_encoder_name = get_env_var("TEXT_ENCODER", DEFAULT_TEXT_ENCODER)
    if text_encoder_name not in TEXT_ENCODER_PRESETS:
        available = ", ".join(sorted(TEXT_ENCODER_PRESETS))
        raise ValueError(f"Unknown TEXT_ENCODER='{text_encoder_name}'. Available: {available}")

    preset = TEXT_ENCODER_PRESETS[text_encoder_name]
    # Copy before overriding so the shared preset dict is never mutated.
    kwargs = dict(preset["kwargs"])
    if text_encoder_fp32:
        kwargs["dtype"] = "float32"
    return {
        "_target_": preset["target"],
        **kwargs,
    }


def _select_text_encoder_conf(
    text_encoder_url: str,
    text_encoder_fp32: bool = False,
    mode: str = "auto",
) -> tuple:
    """Return ``(conf, probe)``: the selected encoder conf plus the already-instantiated encoder
    when auto-mode probing built one (reused by the caller so the API client is not constructed
    twice).

    ``mode`` is resolved and validated by load_text_encoder:
    - "api": force TextEncoderAPI
    - "local": force local LLM2VecEncoder
    - "auto": try API first, fallback to local if unreachable
    """
    if mode == "local":
        return _build_local_text_encoder_conf(text_encoder_fp32), None
    if mode == "api":
        return _build_api_text_encoder_conf(text_encoder_url), None

    api_conf = _build_api_text_encoder_conf(text_encoder_url)
    try:
        text_encoder = instantiate_from_dict(api_conf)
        # Probe availability early so inference doesn't fail later.
        text_encoder(["healthcheck"])
        return api_conf, text_encoder
    except Exception as error:
        print(
            "Text encoder service is unreachable, falling back to local LLM2Vec "
            f"encoder. ({type(error).__name__}: {error})"
        )
        return _build_local_text_encoder_conf(text_encoder_fp32), None


def load_text_encoder(
    mode: Optional[str] = None,
    url: Optional[str] = None,
    fp32: bool = False,
    device: Optional[str] = None,
):
    """Select and instantiate a text encoder, ready for inference.

    This is the single place that owns text-encoder selection + instantiation,
    so it can be built once and reused across multiple models (e.g. core / g1 /
    soma) by passing the result into ``load_model(..., text_encoder=...)``.

    Args:
        mode: Backend selection ("auto"/"api"/"local"). When None, falls back
            to the TEXT_ENCODER_MODE env var (default "auto").
        url: Remote service URL. When None, falls back to the TEXT_ENCODER_URL
            env var.
        fp32: Use float32 instead of the default bfloat16.
        device: Target device. When None, uses cuda if available else cpu.

    Returns:
        The instantiated text encoder placed on ``device``.
    """
    if mode is None:
        mode = get_env_var("TEXT_ENCODER_MODE", "auto")
    mode = str(mode).lower()
    if mode not in ("auto", "api", "local"):
        raise ValueError(
            f"Unknown text-encoder mode {mode!r}. Choose 'auto', 'api' or 'local'; "
            "to load a model without a text encoder, pass text_encoder=False to "
            "load_model()."
        )

    resolved_url = url or get_env_var("TEXT_ENCODER_URL", DEFAULT_TEXT_ENCODER_URL)
    print(
        f"Setting up text encoder (mode={mode}); first run may take a while...",
        flush=True,
    )
    conf, text_encoder = _select_text_encoder_conf(resolved_url, fp32, mode=mode)
    if text_encoder is None:
        # Placement is handled below via .to(); drop any device kwarg the preset
        # may carry so it doesn't conflict (e.g. accelerate device_map="auto").
        conf = dict(conf)
        conf.pop("device", None)
        text_encoder = instantiate_from_dict(conf)

    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float32 if fp32 else torch.bfloat16
    try:
        return text_encoder.to(device=device, dtype=dtype)
    except ValueError:
        # bnb 8-bit/4-bit models refuse dtype casts - move device only
        return text_encoder.to(device=device)


def load_model(
    modelname=None,
    device=None,
    eval_mode: bool = True,
    default_family: Optional[str] = None,
    text_encoder=None,
    text_encoder_fp32: bool = False,
    text_encoder_mode: Optional[str] = None,
    text_encoder_url: Optional[str] = None,
    return_config: bool = False,
    checkpoints_dir: Optional[str] = None,
):
    """Load a released Ardy model.

    ``modelname`` may be a short key ("core"/"g1"/"soma") or a full folder name
    ("Ardy-Core-RP-20FPS-Horizon40"). If a local checkpoints dir is given (via
    ``checkpoints_dir`` or the ``CHECKPOINTS_DIR`` env var) the model is loaded
    from ``<checkpoints_dir>/<full_name>``; otherwise it is downloaded from HF.

    Args:
        modelname: Short key or full folder name; uses DEFAULT_MODEL if None.
        device: Target device for the model (e.g. 'cuda', 'cpu').
        eval_mode: If True, set model to eval mode.
        default_family: Ignored (kept for call-site compatibility).
        text_encoder: Pre-built text encoder to reuse, or False to load the
            model without any text encoder (model.text_encoder is left as
            None). When None (the default), one is built via
            ``load_text_encoder``.
        text_encoder_fp32: If True, uses fp32 for the text encoder rather than default bfloat16.
        text_encoder_mode: Backend selection ("auto"/"api"/"local"). When None,
            falls back to the TEXT_ENCODER_MODE env var (default "auto").
            Ignored unless ``text_encoder`` is None.
        text_encoder_url: URL of the remote text-encoder service. When None,
            falls back to the TEXT_ENCODER_URL env var.
        checkpoints_dir: Local dir holding released model folders. When None,
            falls back to the CHECKPOINTS_DIR env var; if neither is set the
            model is downloaded from Hugging Face.

    Returns:
        Loaded model in eval mode, or (model, confg)  if return_config is true

    Raises:
        ValueError: If modelname cannot be resolved to a released model.
        FileNotFoundError: If config.yaml is missing in the model folder.
    """
    if modelname is None:
        modelname = DEFAULT_MODEL

    # Local dir if CHECKPOINTS_DIR is set (arg or env), otherwise download from HF.
    checkpoints_dir = checkpoints_dir or get_env_var("CHECKPOINTS_DIR")
    # Resolve after checkpoints_dir so local-only folders (beyond the three
    # released models) are accepted when loading from a local dir.
    full_name = resolve_model_name(modelname, checkpoints_dir=checkpoints_dir)
    if checkpoints_dir:
        model_path = Path(checkpoints_dir) / full_name
        if not model_path.exists():
            raise FileNotFoundError(f"Model {full_name!r} not found under CHECKPOINTS_DIR {checkpoints_dir!r}.")
    else:
        model_path = _download_from_hf(full_name)

    model_config_path = model_path / "config.yaml"
    if not model_config_path.exists():
        raise FileNotFoundError(f"The model folder exists but config.yaml is missing: {model_config_path}")

    model_conf = OmegaConf.load(model_config_path)

    # Resolve the text encoder: False means load the model without one, a
    # pre-built instance is reused as-is, and None (the default) builds one
    # here via load_text_encoder (which resolves a None mode through the
    # TEXT_ENCODER_MODE env var). Identity checks, not truthiness: False and
    # None mean different things.
    if text_encoder is False:
        text_encoder = None
    elif text_encoder is None:
        text_encoder = load_text_encoder(
            mode=text_encoder_mode,
            url=text_encoder_url,
            fp32=text_encoder_fp32,
            device=device,
        )

    runtime_conf = OmegaConf.create({"checkpoint_dir": str(model_path)})
    model_cfg = OmegaConf.to_container(OmegaConf.merge(model_conf, runtime_conf), resolve=True)
    model_cfg.pop("checkpoint_dir", None)
    # The text encoder is attached after construction (or left as None for
    # text_encoder=False), so prevent Hydra from instantiating one during
    # construction.
    model_cfg["text_encoder"] = None

    model = instantiate_from_dict(model_cfg, overrides={"device": device})
    if text_encoder is not None:
        model.text_encoder = text_encoder

    if eval_mode:
        model = model.eval()
    if return_config:
        return model, model_cfg
    return model
